/** Renders "23.8 °C" as a number with a quieter unit; anything else as-is */
export function MetricValue({ value }: { value: string }) {
  const split = value.lastIndexOf(" ");
  const head = split > 0 ? value.slice(0, split) : "";
  if (!head || Number.isNaN(Number(head.replace(/,/g, "")))) return <>{value}</>;
  return (
    <>
      {head}
      <span className="unit">{value.slice(split + 1)}</span>
    </>
  );
}
