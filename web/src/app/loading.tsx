export default function Loading() {
  return (
    <div className="loadingShell" role="status" aria-label="Loading farm dashboard">
      <div className="loadingPanel" />
      <div className="loadingGrid">
        <div className="loadingCard" />
        <div className="loadingCard" />
        <div className="loadingCard" />
      </div>
    </div>
  );
}
