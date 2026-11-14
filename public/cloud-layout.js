export const cloudWidth = 1200;
export const cloudHeight = 610;
export const cloudColors = ['#128b7d', '#884dbd', '#cb4d61', '#936700', '#343c76'];
export const cloudFont = size => `800 ${size}px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`;

export function layoutCloud(words, measure) {
  if (!words.length) return [];
  const ranked = words.map((word, index) => ({ ...word, index })).sort((a, b) => b.count - a.count);
  const max = ranked[0].count;
  const min = ranked.at(-1).count;
  let base = Math.min(43, 230 / Math.sqrt(words.length));
  const placed = [];
  for (;;) {
    placed.length = 0;
    for (const [rank, word] of ranked.entries()) {
      const strength = max === min ? .22 : (word.count - min) / (max - min);
      const size = Math.min(base * (1 + 3.3 * strength), base * 5.8 / Math.sqrt([...word.word].length));
      const halfWidth = measure(word.word, size) / 2 + 3;
      const halfHeight = size * .55 + 2;
      for (let step = 0; step < 2400; step++) {
        const angle = step * 2.39996323;
        const radius = Math.sqrt(step / 2400);
        const x = cloudWidth / 2 + Math.cos(angle) * radius * (cloudWidth / 2 - halfWidth - 18);
        const y = cloudHeight / 2 + Math.sin(angle) * radius * (cloudHeight / 2 - halfHeight - 14);
        if (placed.some(p => Math.abs(p.x - x) < p.halfWidth + halfWidth && Math.abs(p.y - y) < p.halfHeight + halfHeight)) continue;
        placed.push({ ...word, x, y, size, halfWidth, halfHeight });
        break;
      }
      if (placed.length === rank) break;
    }
    if (placed.length === ranked.length) return placed;
    base *= .9;
  }
}
