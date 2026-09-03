const LUX_TO_PPFD_FACTOR = 54;

export function calibrateLightPpfd(lux: number) {
  return lux / LUX_TO_PPFD_FACTOR;
}

export function getCalibratedLightPpfd(
  lux: number | null | undefined,
  ppfd: number | null | undefined,
) {
  if (typeof ppfd === "number" && Number.isFinite(ppfd) && ppfd >= 0) {
    return ppfd;
  }

  if (typeof lux === "number" && Number.isFinite(lux) && lux >= 0) {
    return calibrateLightPpfd(lux);
  }

  return null;
}
