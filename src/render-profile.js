// One profile for phones and desktops: keep the look, cap the cost.
export const renderProfile = {
  pixelRatio: 1.5,
  antialias: true,
  shadowSize: 2048,
  anisotropy: 8,
  // Seats are ~0.62 m apart; occupancy < 1 leaves a few empty seats showing.
  crowdSpacing: 0.62,
  crowdOccupancy: 0.9,
};
