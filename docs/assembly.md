# 3D assembly: parts seated as the finished product

When the brief says "RC car", the 3D scene should show a car — not bench rows.
The assembly stage (between `diagram` and `instructions`) decides how every
part sits in 3D space as the finished product: the model authors the shape,
and a deterministic fallback covers offline runs and model failures.

## Data flow

```text
diagram.json
  └─ assembly stage ── model proposes (archetype + bindings + mounts)
      │                  └─ resolver validates + completes (heuristic fills gaps)
      │                  └─ heuristic-only when offline / on failure
      ├─ ProjectState.assembly (ResolvedAssemblyPlan: spec + bindings + placements)
      ├─ simulation bundle ── pruned view + baked x3d/y3d/z3d in the .vlx
      └─ frontend ── pushes the .vlx, then the spec (set_assembly)
                         └─ LiveGround poses bound parts from the mounts every frame
```

## The two shape libraries must agree

The pushed spec's mounts are the scene's per-frame posing source of truth, so
the archetype tables exist twice and must match mount-for-mount:

- PES: `src/modules/assembly-planner/archetypes.ts` (used by the resolver,
  validation overlap checks, and the `.vlx` bake)
- Velxio: `external/velxio/frontend/src/scene3d/assembly/archetypes.ts`
  (used by standalone auto-detect and archetype presets)

`pnpm verify:assembly` fails on any drift, then resolves a sample car, drone,
and static build through the real resolver and asserts every part is seated,
each spec passes Velxio's own `isAssemblySpec`, and no false overlap warnings
fire. Run it after touching either table.

## Mount semantics (read before editing tables)

- `mount.at` is the part's **centre** in chassis-local mm, not its base.
- Wheel-mount heights equal the wheel radius minus the archetype origin Y, so
  parametric wheels rest exactly on the bench (e.g. 2WD: 28 + 5 origin = 33 ≈
  ⌀65/2). The balancer's tilt pivot is derived from the wheel mounts.
- Rider mounts (controller, battery, IMU) are seeds: the resolver lifts them
  to the rendered deck surface (large flat plates grow a second deck, which
  riders sit on top of) plus half the part height — then rewrites the pushed
  mounts to the exact resolved centres, so per-frame posing reproduces the
  physics exactly. Sensor mounts are mast positions and are never lifted.
- Wheels seat on their motor shafts and propellers on their motors; the
  interpenetration is by design and overlap checks skip axle joints.

## Follower seats

Parts with no named mount (motor drivers, extra sensors, propellers, model
extras) are deck-stacked around the seated parts and emitted as
`passenger_0…passenger_7` mounts + bindings, so the chassis carries them when
it drives. Beyond 8 followers the rest stay where the build baked them.

## Re-planning and repairs

- `POST /api/projects/[id]/assembly` (`mode: auto | model | heuristic`)
  re-plans the shape from the current diagram; the Simulation tab's
  "re-assemble in 3D" button calls it and re-pushes onto the canvas.
- Validation §12 (`assembly.seats`) errors on seats pointing at parts that no
  longer exist and on non-finite/out-of-bounds placements; the fixer prunes
  them (`prune_assembly`), and pruned parts fall back to the bench grid.
  Overlaps are warnings, never auto-fixed.
- Builds that predate the stage get the deterministic shape derived on read.
