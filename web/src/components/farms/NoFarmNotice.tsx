"use client";

import { useSelectedFarm } from "@/components/farms/FarmContext";
import styles from "@/components/farms/NoFarmNotice.module.css";

/** Shown in place of a farm's page while there's no farm to show */
export function NoFarmNotice({ title }: { title: string }) {
  const { loading, problem } = useSelectedFarm();

  return (
    <section className="pageSection">
      <div className={`glassPanel ${styles.notice}`} role="status">
        <span className="eyebrow">{title}</span>
        <h1 className="pageTitle">{loading ? "Loading farms…" : "No farm to show"}</h1>
        {problem ? <p className="pageLead">{problem}</p> : null}
      </div>
    </section>
  );
}
