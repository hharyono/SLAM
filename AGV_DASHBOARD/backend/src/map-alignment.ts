export type MappingPose = { x: number; y: number; yaw: number };
export type MapAlignment = {
  applied_rotation_rad: number;
  previous_origin_x_m: number;
  previous_origin_y_m: number;
  previous_origin_yaw_rad: number;
  source_known_min_x_m: number;
  source_known_min_y_m: number;
};

export function readAlignment(value: unknown): MapAlignment {
  const keys: (keyof MapAlignment)[] = [
    'applied_rotation_rad',
    'previous_origin_x_m',
    'previous_origin_y_m',
    'previous_origin_yaw_rad',
    'source_known_min_x_m',
    'source_known_min_y_m',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    keys.some((key) => !Number.isFinite((value as MapAlignment)[key]))
  ) {
    throw new Error('Invalid map alignment transform');
  }
  return value as MapAlignment;
}

// map_align rotates image-local metric coordinates, then subtracts the crop bounds.
export function alignMappingPose(pose: MappingPose, alignment?: MapAlignment): MappingPose {
  if (!alignment) return { ...pose };
  const angle = alignment.applied_rotation_rad - alignment.previous_origin_yaw_rad;
  const c = Math.cos(angle),
    s = Math.sin(angle);
  const x = pose.x - alignment.previous_origin_x_m;
  const y = pose.y - alignment.previous_origin_y_m;
  const yaw = pose.yaw + angle;
  return {
    x: c * x - s * y - alignment.source_known_min_x_m,
    y: s * x + c * y - alignment.source_known_min_y_m,
    yaw: Math.atan2(Math.sin(yaw), Math.cos(yaw)),
  };
}
