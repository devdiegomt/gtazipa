/** Formatos de public/world/ (generados por pipeline/build_world.py). */

export interface WorldMeta {
  version: number;
  generatedUtc: string;
  origin: {
    lat: number; lon: number; epsg: number; utmE: number; utmN: number;
    scaleFactor: number; convergenceDeg: number; elevation: number; definition: string;
  };
  area: { half: number };
  terrain: { file: string; n: number; spacing: number; half: number; minY: number; maxY: number };
  ground: { file: string; half: number };
  plaza: {
    area: number; ring: [number, number][];
    /** Parte adoquinada (sin calzadas vehiculares). */
    paved?: [number, number][];
    plane?: { a: number; bx: number; bz: number; slopeDeg: number; residualStd: number } | null;
    planters?: { osm: string; x: number; y: number; z: number }[];
  };
  landmarks: Landmark[];
  files: { buildings: string; buildingsMeta: string; roads: string; corners: string; props: string };
  stats: Record<string, unknown>;
  attribution: string[];
}

export interface LandmarkModel {
  file: string; origin: [number, number]; axisU: [number, number]; axisV: [number, number];
  floorY: number; facadeWidth: number; triangles: number;
}

export interface Landmark {
  osm: string; name: string; x: number; z: number; height: number; estimated: boolean; model?: LandmarkModel | null;
  groundY: number; area: number; ring: [number, number][];
}

export interface Road {
  id: number; name: string | null; highway: string; width: number; sidewalk: number;
  surface: string; oneway: boolean; area: boolean; pts: [number, number][];
}

export interface Corner {
  node: number; lat: number; lon: number; x: number; z: number; streets: string[];
}

export interface BuildingMeta {
  i: number; src: string; osm: string | null; ov: string | null; arch: string; rule: string;
  h: number; lv: number | null; est: boolean; hsrc: string; blk: string; area: number;
  c: [number, number]; gy: number; name?: string;
}

export interface Prop { kind: 'tree' | 'lamp'; osm: string; x: number; y: number; z: number; procedural?: boolean }
