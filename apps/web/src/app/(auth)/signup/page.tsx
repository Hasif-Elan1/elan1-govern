import type { Metadata } from "next";
import { SignupForm } from "../forms";

export const metadata: Metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold">Create your Elan1 Govern account</h1>
      <p className="mt-1.5 mb-7 text-ink-2">Set up takes about two minutes. You can try everything with demo data first.</p>
      <SignupForm />
    </>
  );
}
