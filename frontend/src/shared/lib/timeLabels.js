export function fmtRoundLabel(hour) {
  if (!hour) {
    return "";
  }
  const [date, time] = hour.split("T");
  const [, m, d] = date.split("-");
  const hh = (time || "").slice(0, 5);

  return `${Number(m)}月${Number(d)}日 · ${hh}`;
}
