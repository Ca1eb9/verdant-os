import type { ReactNode } from "react";
import { TopNav } from "@/components/layout/TopNav";
import styles from "@/components/layout/AppShell.module.css";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <TopNav />
      <main className={styles.main}>{children}</main>
    </div>
  );
}
