"use client";

import { useActionState, useEffect, useState } from "react";
import { signIn, type SignInState } from "@/app/login/actions";
import { clearStoredReadings } from "@/lib/stored-readings";
import styles from "@/app/login/login.module.css";

const INITIAL: SignInState = { error: null, email: "" };

export function LoginForm({ next, disabled }: { next: string; disabled: boolean }) {
  const [state, action, pending] = useActionState(signIn, INITIAL);
  const [showPassword, setShowPassword] = useState(false);

  // Signed out, by choice or because the session ended: nothing from the farm stays on this device
  useEffect(clearStoredReadings, []);

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
          spellCheck={false}
          required
          autoFocus
          disabled={disabled}
        />
      </label>

      <label className={styles.field}>
        <span className={styles.label}>Password</span>
        <span className={styles.passwordWrap}>
          <input
            name="password"
            type={showPassword ? "text" : "password"}
            className={`controlSelect ${styles.input}`}
            autoComplete="current-password"
            required
            disabled={disabled}
          />
          <button
            type="button"
            className={styles.reveal}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
            onClick={() => setShowPassword((shown) => !shown)}
            disabled={disabled}
          >
            {showPassword ? "Hide" : "Show"}
          </button>
        </span>
      </label>

      {state.error ? (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      ) : null}

      <button type="submit" className={styles.submit} disabled={pending || disabled}>
        {pending ? <span className={styles.spinner} aria-hidden /> : null}
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
