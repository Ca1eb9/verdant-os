"use client";

import { useActionState } from "react";
import { signIn, type SignInState } from "@/app/login/actions";
import styles from "@/app/login/login.module.css";

const INITIAL: SignInState = { error: null, email: "" };

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signIn, INITIAL);

  return (
    <form action={action} className={styles.form}>
      <input type="hidden" name="next" value={next} />

      <label className={styles.field}>
        <span className={styles.label}>Email</span>
        <input
          name="email"
          type="email"
          defaultValue={state.email}
          className={`controlSelect ${styles.input}`}
          autoComplete="username"
          inputMode="email"
          required
          autoFocus
        />
      </label>

      <label className={styles.field}>
        <span className={styles.label}>Password</span>
        <input
          name="password"
          type="password"
          className={`controlSelect ${styles.input}`}
          autoComplete="current-password"
          required
        />
      </label>

      {state.error ? (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      ) : null}

      <button type="submit" className={styles.submit} disabled={pending}>
        {pending ? <span className={styles.spinner} aria-hidden /> : null}
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
