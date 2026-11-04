import type { Metadata } from "next";
import { BackupNavView } from "@/components/backup-nav/BackupNavView";

export const metadata: Metadata = {
  title: "Backup nav",
};

export default function BackupNavPage() {
  return <BackupNavView />;
}
