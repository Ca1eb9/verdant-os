import type { ReactNode } from "react";
import { SideNav } from "@/components/layout/SideNav";
import { TopNav } from "@/components/layout/TopNav";
import styles from "@/components/layout/AppShell.module.css";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <SideNav />
      <div className={styles.column}>
        <TopNav />
        <main className={styles.main}>{children}</main>
      </div>
    </div>
  );
}
