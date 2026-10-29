import { DecryptCommand, GenerateDataKeyCommand, KMSClient, type DecryptCommandOutput, type GenerateDataKeyCommandOutput } from "@aws-sdk/client-kms";
import { decrypt, encrypt } from "@gate/core";
import type { KeyCtx, KeyProvider } from "./keys";

/** The two KMS commands this provider uses. `KMSClient` satisfies it; tests pass an in-memory fake. */
export interface KmsSender {
  send(command: GenerateDataKeyCommand | DecryptCommand): Promise<Partial<GenerateDataKeyCommandOutput & DecryptCommandOutput>>;
}

const FORMAT = "kms1";
const aad = (orgId: string, kid: string) => `org-key:${orgId}:${kid}`;

/** A KMS client on the standard AWS credential chain (environment, profile, instance or task role). Credentials are never read or logged here. */
export function kmsClient(region: string): KmsSender {
  return new KMSClient({ region });
}

/**
 * Envelope encryption with AWS KMS (name `aws-kms`). `wrap` asks KMS for a fresh AES-256 data key
 * under `keyId` with the encryption context `{ orgId, kid }`, encrypts the PEM with it (AES-256-GCM,
 * AAD bound to org and key id) and stores the KMS-encrypted data key alongside:
 * `kms1:<base64 encrypted data key>:<ciphertext>`. `unwrap` has KMS decrypt the data key, which it
 * only does for the same key and the same context, so a row moved to another org or key id fails
 * at KMS (and is logged in CloudTrail). The plaintext data key is zeroed after use. Signing still
 * happens in the gate process with the unwrapped key.
 */
export class AwsKmsKeyProvider implements KeyProvider {
  readonly name = "aws-kms";
  readonly #kms: KmsSender;
  readonly #keyId: string;

  constructor(opts: { keyId: string; client: KmsSender }) {
    if (!opts.keyId) throw new Error("AWS_KMS_KEY_ID is required for the aws-kms key provider");
    this.#kms = opts.client;
    this.#keyId = opts.keyId;
  }

  async wrap(privateKeyPem: string, { orgId, kid }: KeyCtx): Promise<string> {
    const out = await this.#call("GenerateDataKey", new GenerateDataKeyCommand({ KeyId: this.#keyId, KeySpec: "AES_256", EncryptionContext: { orgId, kid } }));
    if (!out.Plaintext || out.Plaintext.length !== 32 || !out.CiphertextBlob?.length) throw new Error("AWS KMS GenerateDataKey returned no usable data key");
    try {
      const body = encrypt(Buffer.from(out.Plaintext).toString("hex"), privateKeyPem, aad(orgId, kid));
      return [FORMAT, Buffer.from(out.CiphertextBlob).toString("base64"), body].join(":");
    } finally {
      out.Plaintext.fill(0);
    }
  }

  async unwrap(privateKeyEnc: string, { orgId, kid }: KeyCtx): Promise<string> {
    const [format, blob, body, ...rest] = privateKeyEnc.split(":");
    if (format !== FORMAT || !blob || !body || rest.length) throw new Error("not an aws-kms wrapped key");
    const out = await this.#call("Decrypt", new DecryptCommand({ KeyId: this.#keyId, CiphertextBlob: Buffer.from(blob, "base64"), EncryptionContext: { orgId, kid } }));
    if (!out.Plaintext || out.Plaintext.length !== 32) throw new Error("AWS KMS Decrypt returned no usable data key");
    try {
      return decrypt(Buffer.from(out.Plaintext).toString("hex"), body, aad(orgId, kid));
    } finally {
      out.Plaintext.fill(0);
    }
  }

  /** Calls KMS; failures keep only the AWS error name, so nothing from the request or the credentials reaches a log. */
  async #call(op: string, command: GenerateDataKeyCommand | DecryptCommand) {
    try {
      return await this.#kms.send(command);
    } catch (e) {
      throw new Error(`AWS KMS ${op} failed: ${e instanceof Error ? e.name : "unknown error"}`);
    }
  }
}
