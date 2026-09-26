import type { Metadata } from "next";
import { FarmView } from "@/components/farm/FarmView";

export const metadata: Metadata = {
  title: "Farm",
};

export default function FarmPage() {
  return <FarmView />;
}
