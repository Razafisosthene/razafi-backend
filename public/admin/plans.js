
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  }[c]));
}

function formatDurationFromPlan(p) {
  let minutes = null;
  if (p.duration_minutes != null) minutes = Number(p.duration_minutes);
  else if (p.duration_hours != null) minutes = Number(p.duration_hours) * 60;

  if (!minutes || minutes <= 0) return "—";

  if (minutes < 60) return `${minutes} min`;

  const h = Math.floor(minutes / 60);
  const m = minutes % 60;

  if (h < 24) {
    if (m === 0) return `${h}h`;
    return `${h}h${String(m).padStart(2,"0")}`;
  }

  const d = Math.floor(h / 24);
  const rh = h % 24;

  if (rh === 0) return `${d}d`;
  return `${d}d ${rh}h`;
}
