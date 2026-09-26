import type { Metadata } from "next";
import { LoginForm } from "@/app/login/LoginForm";
import { AssetImage } from "@/components/ui/AssetImage";
import styles from "@/app/login/login.module.css";

export const metadata: Metadata = {
  title: "Sign in",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;

  return (
    <main className={styles.page}>
      <div className={`glassPanel ${styles.card}`}>
        <header className={styles.header}>
          <AssetImage
            src="/images/sprout-logo.webp"
            alt=""
            fallback={"🌿"}
            className={styles.logo}
            fallbackClassName={`${styles.logo} assetFallback`}
          />
          <span className="eyebrow">Vertical Farm Control</span>
          <h1 className="pageTitle">VerdantOS</h1>
          <p className={styles.lead}>Sign in to monitor and command the farm.</p>
        </header>
        <LoginForm next={next ?? "/"} />
      </div>
    </main>
  );
}
