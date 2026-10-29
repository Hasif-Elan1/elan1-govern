// The part of node-postgres (pg, already installed with pg-boss) that the console event stream uses.
// pg ships no types of its own; this avoids adding @types/pg for one LISTEN connection.
declare module "pg" {
  export interface Notification {
    processId: number;
    channel: string;
    payload?: string;
  }

  export interface ClientConfig {
    connectionString?: string;
    application_name?: string;
    keepAlive?: boolean;
    connectionTimeoutMillis?: number;
  }

  export class Client {
    constructor(config?: string | ClientConfig);
    connect(): Promise<void>;
    query(text: string): Promise<unknown>;
    end(): Promise<void>;
    on(event: "notification", listener: (n: Notification) => void): this;
    on(event: "error", listener: (e: Error) => void): this;
    on(event: "end", listener: () => void): this;
    removeAllListeners(): this;
  }

  const pg: { Client: typeof Client };
  export default pg;
}
