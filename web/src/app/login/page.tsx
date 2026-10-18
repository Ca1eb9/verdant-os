import type { Metadata } from "next";
import { LoginForm } from "@/app/login/LoginForm";
import { VerdantMark } from "@/components/brand/VerdantMark";
import type { SessionProblem } from "@/lib/auth";
import { getSupabaseAuthConfig } from "@/lib/supabase-config";
import styles from "@/app/login/login.module.css";

export const metadata: Metadata = {
  title: "Sign in",
};

const NOTICES: Record<SessionProblem, string> = {
  unavailable: "Can't reach the sign-in service right now. Try again in a moment.",
  unconfigured: "Sign-in isn't set up on this server yet.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; reason?: string }> }) {
  const { next, reason } = await searchParams;
  const { url, anonKey } = getSupabaseAuthConfig();
  const problem: SessionProblem | null = !url || !anonKey ? "unconfigured" : reason === "unavailable" ? "unavailable" : null;

  return (
    <main className={styles.page}>
      <div className={`glassPanel ${styles.card}`}>
        <header className={styles.header}>
          <VerdantMark className={styles.mark} />
          <span className="eyebrow">Vertical farm control</span>
          <h1 className="pageTitle">VerdantOS</h1>
          <p className={styles.lead}>Sign in to monitor and command the farm.</p>
        </header>
        {problem ? (
          <p className={styles.notice} role="status">
            {NOTICES[problem]}
          </p>
        ) : null}
        <LoginForm next={typeof next === "string" ? next : "/"} disabled={problem === "unconfigured"} />
      </div>
    </main>
  );
}
