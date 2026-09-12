/**
 * assemblyTypes.ts — Declarative mechanical/3D assembly specification.
 *
 * An AssemblySpec tells the 3D scene HOW to lay components out in space and
 * HOW they should move, without hard-coding any one robot shape. Agents
 * (Everflow, MCP clients, the build pipeline) write one of these per project;
 * LiveGround reads it and assembles/animates the scene generically.
 *
 * This is the contract between "the AI decided on a robot" and "the 3D scene
 * knows how to render and simulate it." Adding a new robot shape is a matter
 * of writing a new spec — no scene code changes required.
 */

export type Vec3 = { x: number; y: number; z: number };

/** A point on a chassis where something mounts, in chassis-local mm. */
export interface MountPoint {
  /** Role identifier — used by the mount-resolution rules. */
  role:
    | 'motor_left'
    | 'motor_right'
    | 'motor_fl'
    | 'motor_fr'
    | 'motor_rl'
    | 'motor_rr'
    | 'motor_1' | 'motor_2' | 'motor_3' | 'motor_4' | 'motor_5' | 'motor_6'
    | 'wheel_left'
    | 'wheel_right'
    | 'caster_front' | 'caster_back'
    | 'imu'
    | 'battery'
    | 'controller'       // MCU / driver board / main PCB
    | 'sensor_front' | 'sensor_back' | 'sensor_left' | 'sensor_right'
    | 'passenger';       // anything else rides here
  /** Local position (mm) relative to chassis origin. */
  at: Vec3;
  /** Local Y-axis rotation (degrees) applied to the mounted component. */
  rotY?: number;
  /** Which motor id this mount is attached to (for wheels) — filled by resolver. */
  motorRef?: string;
}

export type ChassisShape =
  | 'horizontal_plate'   // classic 2WD/4WD rover deck, lies flat on the XY plane
  | 'vertical_plate'     // self-balancing bot, stands up along the X axis
  | 'box'                // enclosed body (drone body, RC car shell)
  | 'frame'              // skeletal tube frame (arm base, large rover)
  | 'custom_mesh';       // loaded from a supplied GLB/GLTF URL (future)

export interface ChassisSpec {
  shape: ChassisShape;
  /** Bounding size in mm. */
  size: { x: number; y: number; z: number };
  /** Plate/body thickness in mm. */
  thickness?: number;
  /** Primary color (hex). */
  color?: string;
  /** Mount points declared by the chassis designer. */
  mounts: MountPoint[];
  /** For custom_mesh — future. */
  meshUrl?: string;
  /** Descriptive label. */
  label?: string;
}

/**
 * Wheel spec — describes wheel geometry so the parametric wheel primitive can
 * render it and the kinematics can compute linear speed from RPM.
 */
export interface WheelSpec {
  diameterMm: number;
  widthMm: number;
  /** Which side of the axle the wheel mounts (affects tread mirroring). */
  side?: 'left' | 'right';
  color?: string;
  tireColor?: string;
}

/**
 * Which kinematic model the ground agent runs each frame. Each model takes
 * per-motor live state (turnsPerSecond, direction) and integrates chassis
 * pose (x, z, rotY, plus optional tilt for balancers).
 */
export type KinematicsModel =
  | 'differential_drive'   // 2/4 wheels on a horizontal deck (car, 4WD rover)
  | 'inverted_pendulum'    // self-balancing 2-wheeler (segway-style)
  | 'mecanum'              // 4 omnidirectional wheels
  | 'quadcopter'           // 4 BLDC props, lift + gravity
  | 'hexacopter'
  | 'static';              // bench display — parts assemble but don't drive

export interface KinematicsSpec {
  model: KinematicsModel;
  /** Distance between left/right wheel centers in mm. */
  wheelbaseMm?: number;
  /** Distance between front/back axles in mm (4WD, mecanum). */
  trackMm?: number;
  /** Deadband below which motors are considered still (turns/sec). */
  deadbandRps?: number;
  /** Inverted pendulum / drone parameters — optional per model. */
  gravity?: number;          // mm/s^2
  balancePointDeg?: number;  // target tilt (0 = upright)
  maxTiltDeg?: number;       // past this the bot falls over
  liftK?: number;            // thrust coefficient per turns/sec (drone)
  massKg?: number;
  /** Whether simulated sensor data (IMU, encoders, rangefinders) is fed back
   *  to the running firmware over the emulated I2C/GPIO/serial. When false,
   *  motors still move the chassis visually but firmware sees a static world. */
  closedLoopSensors?: boolean;
}

/**
 * Sensor mounts — when closedLoopSensors is true, the simulator uses these
 * positions to compute what those sensors would read and feeds them back.
 */
export interface SensorMount {
  role: 'imu' | 'rangefinder_front' | 'rangefinder_back' | 'rangefinder_left' | 'rangefinder_right' | 'encoder_left' | 'encoder_right';
  componentId?: string;  // bound at resolution time
  at?: Vec3;             // defaults to mount point by role
}

/**
 * The complete assembly spec. Agents (Everflow/MCP) produce this, LiveGround
 * consumes it. Everything is optional — missing fields fall back to
 * auto-detection heuristics, which preserves the current behavior for projects
 * written before this spec existed.
 */
export interface AssemblySpec {
  /** Archetype hint, e.g. '2wd_rover', 'self_balancer', 'quadcopter', 'robotic_arm'. */
  archetype?: string;
  chassis?: ChassisSpec;
  /** Default wheel geometry applied to wheels mounted on motor mounts. */
  wheel?: WheelSpec;
  kinematics?: KinematicsSpec;
  sensors?: SensorMount[];
  /**
   * Role → componentId binding. The agent can either:
   *   (a) leave this empty and let the resolver match by component type +
   *       nearest mount point, or
   *   (b) pin specific parts to specific roles (e.g. when the agent knows
   *       which motor is left vs right).
   */
  bindings?: Partial<Record<MountPoint['role'], string | string[]>>;
  /** Where the assembled robot sits on the bench (world mm). */
  origin?: Vec3;
  /** Initial heading (deg Y). */
  rotYDeg?: number;
  /** Free-form metadata for the agent's own bookkeeping. */
  meta?: Record<string, unknown>;
}

/** Shape stored on the simulator store / project state. */
export const EMPTY_ASSEMBLY: AssemblySpec = {
  kinematics: { model: 'static' },
};
