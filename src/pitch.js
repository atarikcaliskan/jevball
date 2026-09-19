export const PITCH = {
  length: 105,
  width: 68,
  halfL: 52.5,
  halfW: 34,
  goalWidth: 7.32,
  goalHeight: 2.44,
  goalDepth: 2.2,
  penaltyAreaDepth: 16.5,
  penaltyAreaWidth: 40.32,
  goalAreaDepth: 5.5,
  goalAreaWidth: 18.32,
  centerCircle: 9.15,
  penaltySpot: 11,
  cornerArc: 1,
};

export const TEAMS = [
  {
    id: "home",
    name: "Jev United",
    short: "JEV",
    prefix: "h",
    colors: { shirt: "#e82127", shorts: "#ffffff", socks: "#e82127", keeper: "#f2b705" },
  },
  {
    id: "away",
    name: "System One FC",
    short: "SYS",
    prefix: "a",
    colors: { shirt: "#3e6ae1", shorts: "#171a20", socks: "#3e6ae1", keeper: "#2fbf71" },
  },
];

const slot = (number, role, ax, ay) => ({ role, number, ax, ay });

// Attack-normalized slots: ax −1 own goal line … +1 opponent goal line, ay −1 left … +1 right facing the attack.
export const FORMATIONS = {
  "4-4-2": [
    slot(1, "GK", -0.95, 0),
    slot(2, "RB", -0.58, 0.72),
    slot(3, "LB", -0.58, -0.72),
    slot(4, "CB", -0.68, 0.24),
    slot(5, "CB", -0.68, -0.24),
    slot(6, "CM", -0.2, -0.22),
    slot(7, "RM", -0.08, 0.74),
    slot(8, "CM", -0.16, 0.22),
    slot(9, "ST", 0.42, 0.18),
    slot(10, "ST", 0.34, -0.2),
    slot(11, "LM", -0.08, -0.74),
  ],
  "4-3-3": [
    slot(1, "GK", -0.95, 0),
    slot(2, "RB", -0.56, 0.74),
    slot(3, "LB", -0.56, -0.74),
    slot(4, "CB", -0.68, 0.24),
    slot(5, "CB", -0.68, -0.24),
    slot(6, "DM", -0.34, 0),
    slot(7, "RW", 0.36, 0.72),
    slot(8, "CM", -0.08, 0.32),
    slot(9, "ST", 0.46, 0),
    slot(10, "AM", -0.02, -0.3),
    slot(11, "LW", 0.36, -0.72),
  ],
  "3-5-2": [
    slot(1, "GK", -0.95, 0),
    slot(2, "RWB", -0.3, 0.82),
    slot(3, "LWB", -0.3, -0.82),
    slot(4, "CB", -0.68, 0.42),
    slot(5, "CB", -0.72, 0),
    slot(6, "CB", -0.68, -0.42),
    slot(7, "CM", -0.1, 0.34),
    slot(8, "DM", -0.32, 0),
    slot(9, "ST", 0.44, 0.2),
    slot(10, "AM", 0.04, -0.3),
    slot(11, "ST", 0.38, -0.2),
  ],
};

export const ROLE_SPEED = {
  GK: 6.2, CB: 7.3, LB: 7.8, RB: 7.8, LWB: 7.9, RWB: 7.9, DM: 7.4, CM: 7.6,
  LM: 8.0, RM: 8.0, AM: 7.7, LW: 8.1, RW: 8.1, ST: 8.0,
};
export const WIDE_ROLES = new Set(["LB", "RB", "LWB", "RWB", "LM", "RM", "LW", "RW"]);
export const FORWARD_ROLES = new Set(["ST", "LW", "RW", "AM", "LM", "RM"]);
export const BACK_ROLES = new Set(["CB", "LB", "RB", "DM", "LWB", "RWB"]);
