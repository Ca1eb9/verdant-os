"use client";

import { useEffect, useState } from "react";
import { isFarmNet } from "@/lib/farm/data-source";

/**
 * The Backup nav page (node_reached, for a robot built with
 * CONFIRM_NAV_ENABLED): only in a build with NEXT_PUBLIC_CONFIRM_NAV=true (the
 * Pi's dashboard.env), and only opened from the Pi, as FarmNet has the only
 * path that never delivers a tap late. Fixed at build time.
 */
export const BACKUP_NAV_BUILT = process.env.NEXT_PUBLIC_CONFIRM_NAV === "true";

/** Whether to offer the Backup nav page here. False until hydration, like isFarmNet() */
export function useBackupNav() {
  const [on, setOn] = useState(false);
  useEffect(() => setOn(BACKUP_NAV_BUILT && isFarmNet()), []);
  return on;
}
