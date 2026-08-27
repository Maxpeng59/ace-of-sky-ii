// One source of truth for the animated ocean. Rendering, collisions, torpedoes,
// player ships, AI ships, and carriers must all sample this same surface.
const AX = 0.0042, AZ = 0.0056, AD = 0.011;
const SX = 0.55, SZ = 0.43, SD = 0.95;
const HX = 3.4, HZ = 2.7, HD = 1.2;

export function seaWaveHeight(x, z, t = 0){
  return Math.sin(x * AX + t * SX) * HX +
    Math.cos(z * AZ + t * SZ) * HZ +
    Math.sin((x + z) * AD + t * SD) * HD;
}

// Reuses `out` when supplied so the 50k-vertex water update allocates nothing.
export function sampleSeaWave(x, z, t = 0, out = {}){
  const px = x * AX + t * SX;
  const pz = z * AZ + t * SZ;
  const pd = (x + z) * AD + t * SD;
  const cosD = Math.cos(pd);
  out.height = Math.sin(px) * HX + Math.cos(pz) * HZ + Math.sin(pd) * HD;
  out.dhdx = HX * AX * Math.cos(px) + HD * AD * cosD;
  out.dhdz = -HZ * AZ * Math.sin(pz) + HD * AD * cosD;
  return out;
}
