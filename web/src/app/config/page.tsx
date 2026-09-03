import type { Metadata } from "next";
import { ConfigView } from "@/components/config/ConfigView";

export const metadata: Metadata = {
  title: "Config",
};

export default function ConfigPage() {
  return <ConfigView />;
}
