"""
Velxio MCP Server

Exposes the following tools to MCP-compatible agents (e.g. Claude):

  - compile_project       Compile Arduino sketch files → hex / binary
  - run_project           Compile and return simulation-ready artifacts
  - import_wokwi_json     Parse a Wokwi diagram.json → Velxio circuit
  - export_wokwi_json     Serialise a Velxio circuit → Wokwi diagram.json
  - create_circuit        Create a new circuit definition
  - update_circuit        Merge changes into an existing circuit definition
  - generate_code_files   Generate starter Arduino code from a circuit

Transport:
  - stdio  — run `python mcp_server.py` for Claude Desktop / CLI agents
  - SSE    — mounted at /mcp in the FastAPI app for HTTP-based agents
"""

from __future__ import annotations

import json
import sys
from typing import Annotated, Any

from mcp.server.fastmcp import FastMCP

from app.mcp.wokwi import (
    format_wokwi_diagram,
    generate_arduino_sketch,
    parse_wokwi_diagram,
)
from app.services.arduino_cli import ArduinoCLIService

# ---------------------------------------------------------------------------
# Server setup
# ---------------------------------------------------------------------------

mcp = FastMCP(
    name="velxio",
    instructions=(
        "Velxio MCP server — create circuits, import/export Wokwi JSON, "
        "generate Arduino code, and compile projects."
    ),
)

_arduino = ArduinoCLIService()

# ---------------------------------------------------------------------------
# compile_project
# ---------------------------------------------------------------------------


@mcp.tool()
async def compile_project(
    files: Annotated[
        list[dict[str, str]],
        "List of source files. Each item must have 'name' (filename, e.g. 'sketch.ino') "
        "and 'content' (file text).",
    ],
    board: Annotated[
        str,
        "Arduino board FQBN, e.g. 'arduino:avr:uno' or 'rp2040:rp2040:rpipico'. "
        "Defaults to 'arduino:avr:uno'.",
    ] = "arduino:avr:uno",
) -> dict[str, Any]:
    """
    Compile one or more Arduino sketch files and return the compiled artifact.

    Returns a dict with:
      - success (bool)
      - hex_content (str | null)    Intel HEX for AVR boards
      - binary_content (str | null) Base-64 .bin/.uf2 for RP2040
      - binary_type (str | null)    'bin' or 'uf2'
      - stdout (str)
      - stderr (str)
      - error (str | null)
    """
    for f in files:
        if "name" not in f or "content" not in f:
            return {
                "success": False,
                "error": "Each file entry must have 'name' and 'content' keys.",
                "stdout": "",
                "stderr": "",
            }

    try:
        result = await _arduino.compile(files, board)
        return result
    except Exception as exc:  # pragma: no cover
        return {
            "success": False,
            "error": str(exc),
            "stdout": "",
            "stderr": "",
        }


# ---------------------------------------------------------------------------
# run_project
# ---------------------------------------------------------------------------


@mcp.tool()
async def run_project(
    files: Annotated[
        list[dict[str, str]],
        "List of source files (same format as compile_project).",
    ],
    board: Annotated[str, "Board FQBN (default: 'arduino:avr:uno')."] = "arduino:avr:uno",
) -> dict[str, Any]:
    """
    Compile the project and return simulation-ready artifacts.

    The Velxio frontend can load the returned hex_content / binary_content
    directly into its AVR / RP2040 emulator.  Actual execution happens
    client-side in the browser.

    Returns the same payload as compile_project plus a 'simulation_ready' flag.
    """
    result = await compile_project(files=files, board=board)
    result["simulation_ready"] = result.get("success", False)
    return result


# ---------------------------------------------------------------------------
# import_wokwi_json
# ---------------------------------------------------------------------------


@mcp.tool()
async def import_wokwi_json(
    diagram_json: Annotated[
        str,
        "Wokwi diagram.json content as a JSON string. "
        "Must contain at minimum a 'parts' array.",
    ],
) -> dict[str, Any]:
    """
    Parse a Wokwi diagram.json payload and return a Velxio circuit object.

    The returned circuit can be passed directly to export_wokwi_json,
    generate_code_files, compile_project, or saved as a Velxio project.

    Returns:
      - board_fqbn (str)         Detected Arduino board FQBN
      - components (list)        List of component objects
      - connections (list)       List of connection objects
      - version (int)
    """
    try:
        diagram = json.loads(diagram_json)
    except json.JSONDecodeError as exc:
        return {"error": f"Invalid JSON: {exc}"}

    if not isinstance(diagram, dict):
        return {"error": "diagram_json must be a JSON object."}

    return parse_wokwi_diagram(diagram)


# ---------------------------------------------------------------------------
# export_wokwi_json
# ---------------------------------------------------------------------------


@mcp.tool()
async def export_wokwi_json(
    circuit: Annotated[
        dict[str, Any],
        "Velxio circuit object with 'components', 'connections', and 'board_fqbn'.",
    ],
    author: Annotated[str, "Author name to embed in the diagram (default: 'velxio')."] = "velxio",
) -> dict[str, Any]:
    """
    Convert a Velxio circuit object into a Wokwi diagram.json payload.

    The returned payload is compatible with the Wokwi simulator and can be
    imported using the Wokwi zip import feature in Velxio.

    Returns the Wokwi diagram dict (version, author, editor, parts, connections).
    """
    if not isinstance(circuit, dict):
        return {"error": "circuit must be a JSON object."}

    return format_wokwi_diagram(circuit, author=author)


# ---------------------------------------------------------------------------
# create_circuit
# ---------------------------------------------------------------------------


@mcp.tool()
async def create_circuit(
    board_fqbn: Annotated[
        str,
        "Arduino board FQBN. e.g. 'arduino:avr:uno', 'rp2040:rp2040:rpipico'.",
    ] = "arduino:avr:uno",
    components: Annotated[
        list[dict[str, Any]] | None,
        "List of component objects. Each item may have: "
        "id (str), type (str, Wokwi element type), left (number), top (number), "
        "rotate (number), attrs (object).",
    ] = None,
    connections: Annotated[
        list[dict[str, Any]] | None,
        "List of connection objects. Each item may have: "
        "from_part (str), from_pin (str), to_part (str), to_pin (str), color (str).",
    ] = None,
) -> dict[str, Any]:
    """
    Create a new Velxio circuit definition.

    Example component types: wokwi-led, wokwi-pushbutton, wokwi-resistor,
    wokwi-buzzer, wokwi-servo, wokwi-lcd1602.

    Example connection:
      { "from_part": "uno", "from_pin": "13", "to_part": "led1", "to_pin": "A",
        "color": "green" }

    Returns the new circuit object (board_fqbn, components, connections, version).
    """
    components_list = components if components is not None else []
    connections_list = connections if connections is not None else []

    # Normalise components
    normalised_components: list[dict[str, Any]] = []
    for i, comp in enumerate(components_list):
        normalised_components.append(
            {
                "id": comp.get("id", f"comp{i}"),
                "type": comp.get("type", ""),
                "left": float(comp.get("left", 0)),
                "top": float(comp.get("top", 0)),
                "rotate": int(comp.get("rotate", 0)),
                "attrs": dict(comp.get("attrs", {})),
            }
        )

    # Normalise connections
    normalised_connections: list[dict[str, Any]] = []
    for conn in connections_list:
        normalised_connections.append(
            {
                "from_part": conn.get("from_part", ""),
                "from_pin": conn.get("from_pin", ""),
                "to_part": conn.get("to_part", ""),
                "to_pin": conn.get("to_pin", ""),
                "color": conn.get("color", "green"),
            }
        )

    return {
        "board_fqbn": board_fqbn,
        "components": normalised_components,
        "connections": normalised_connections,
        "version": 1,
    }


# ---------------------------------------------------------------------------
# update_circuit
# ---------------------------------------------------------------------------


@mcp.tool()
async def update_circuit(
    circuit: Annotated[
        dict[str, Any],
        "Existing Velxio circuit object to update.",
    ],
    add_components: Annotated[
        list[dict[str, Any]] | None,
        "Components to add. Merged after existing components.",
    ] = None,
    remove_component_ids: Annotated[
        list[str] | None,
        "IDs of components to remove.",
    ] = None,
    add_connections: Annotated[
        list[dict[str, Any]] | None,
        "Connections to add.",
    ] = None,
    remove_connections: Annotated[
        list[dict[str, Any]] | None,
        "Connections to remove (matched by from_part+from_pin+to_part+to_pin).",
    ] = None,
    board_fqbn: Annotated[
        str | None,
        "If provided, replaces the circuit board_fqbn.",
    ] = None,
) -> dict[str, Any]:
    """
    Merge changes into an existing Velxio circuit definition.

    Supports adding/removing components and connections, and changing the board.

    Returns the updated circuit object.
    """
    if not isinstance(circuit, dict):
        return {"error": "circuit must be a JSON object."}

    import copy

    updated = copy.deepcopy(circuit)

    if board_fqbn is not None:
        updated["board_fqbn"] = board_fqbn

    # Remove components
    if remove_component_ids:
        remove_set = set(remove_component_ids)
        updated["components"] = [
            c for c in updated.get("components", []) if c.get("id") not in remove_set
        ]

    # Add components
    existing_ids = {c.get("id") for c in updated.get("components", [])}
    for i, comp in enumerate(add_components or []):
        comp_id = comp.get("id", f"comp_new_{i}")
        if comp_id in existing_ids:
            comp_id = f"{comp_id}_new"
        updated.setdefault("components", []).append(
            {
                "id": comp_id,
                "type": comp.get("type", ""),
                "left": float(comp.get("left", 0)),
                "top": float(comp.get("top", 0)),
                "rotate": int(comp.get("rotate", 0)),
                "attrs": dict(comp.get("attrs", {})),
            }
        )

    # Remove connections (exact match)
    if remove_connections:
        def _conn_key(c: dict[str, Any]) -> tuple[str, str, str, str]:
            return (
                c.get("from_part", ""),
                c.get("from_pin", ""),
                c.get("to_part", ""),
                c.get("to_pin", ""),
            )

        remove_keys = {_conn_key(c) for c in remove_connections}
        updated["connections"] = [
            c for c in updated.get("connections", []) if _conn_key(c) not in remove_keys
        ]

    # Add connections
    for conn in (add_connections or []):
        updated.setdefault("connections", []).append(
            {
                "from_part": conn.get("from_part", ""),
                "from_pin": conn.get("from_pin", ""),
                "to_part": conn.get("to_part", ""),
                "to_pin": conn.get("to_pin", ""),
                "color": conn.get("color", "green"),
            }
        )

    return updated


# ---------------------------------------------------------------------------
# generate_code_files
# ---------------------------------------------------------------------------


@mcp.tool()
async def generate_code_files(
    circuit: Annotated[
        dict[str, Any],
        "Velxio circuit object (from create_circuit or import_wokwi_json).",
    ],
    sketch_name: Annotated[
        str,
        "Base name for the generated sketch file (without extension).",
    ] = "sketch",
    extra_instructions: Annotated[
        str,
        "Optional extra instructions or comments to embed in the sketch.",
    ] = "",
) -> dict[str, Any]:
    """
    Generate starter Arduino code files for the given circuit.

    Returns:
      - files: list of { "name": str, "content": str } — ready for compile_project
      - board_fqbn: str — detected board FQBN
    """
    if not isinstance(circuit, dict):
        return {"error": "circuit must be a JSON object."}

    sketch_content = generate_arduino_sketch(circuit, sketch_name=sketch_name)

    if extra_instructions:
        header = f"// {extra_instructions}\n"
        sketch_content = header + sketch_content

    board_fqbn: str = circuit.get("board_fqbn", "arduino:avr:uno")

    return {
        "files": [{"name": f"{sketch_name}.ino", "content": sketch_content}],
        "board_fqbn": board_fqbn,
    }


# ---------------------------------------------------------------------------
# describe_assembly_archetypes
# ---------------------------------------------------------------------------


@mcp.tool()
async def describe_assembly_archetypes() -> dict[str, Any]:
    """
    List the 3D mechanical assembly archetypes the simulator can auto-build.

    An archetype is a preset chassis + wheel/prop geometry + kinematic model.
    After picking one (with optional overrides via apply_assembly_archetype),
    the simulator's live-ground agent will auto-lay the bench into that shape
    and drive/balance/fly it from live motor signals.

    Returns a dict keyed by archetype id, each entry describing the shape,
    typical motors/wheels, kinematics, and the mount roles the chassis provides.
    """
    archetypes: dict[str, dict[str, Any]] = {
        "2wd_rover": {
            "label": "2WD smart car / differential-drive rover",
            "shape": "horizontal_plate",
            "motor_count": 2,
            "extra_parts": ["1× caster wheel", "2× wheels (65mm)"],
            "kinematics": "differential_drive",
            "wheel_diameter_mm": 65,
            "wheelbase_mm": 130,
            "mount_roles": [
                "motor_left", "motor_right", "wheel_left", "wheel_right",
                "caster_front", "controller", "battery", "sensor_front",
                "passenger",
            ],
        },
        "4wd_rover": {
            "label": "4WD / tank-drive rover",
            "shape": "horizontal_plate",
            "motor_count": 4,
            "extra_parts": ["4× wheels (80mm)"],
            "kinematics": "differential_drive",
            "wheel_diameter_mm": 80,
            "wheelbase_mm": 160,
            "track_mm": 180,
            "mount_roles": ["motor_fl", "motor_fr", "motor_rl", "motor_rr", "controller", "battery", "sensor_front"],
        },
        "self_balancer": {
            "label": "Two-wheel self-balancing robot (inverted pendulum)",
            "shape": "vertical_plate",
            "motor_count": 2,
            "extra_parts": ["2× wheels (85mm)", "MPU6050 IMU", "battery (mount low for CoM)"],
            "kinematics": "inverted_pendulum",
            "wheel_diameter_mm": 85,
            "wheelbase_mm": 64,
            "closed_loop_sensors": True,
            "mount_roles": [
                "motor_left", "motor_right", "wheel_left", "wheel_right",
                "imu", "battery", "controller", "sensor_front",
            ],
            "note": "Wheels stay on the axle; chassis tilts with simulated balance physics. "
                    "IMU should be mounted high, battery low.",
        },
        "quadcopter": {
            "label": "Quadcopter X-frame drone",
            "shape": "frame",
            "motor_count": 4,
            "extra_parts": ["4× propellers (127mm)", "IMU", "battery", "flight controller"],
            "kinematics": "quadcopter",
            "wheel_diameter_mm": 127,  # prop diameter
            "wheelbase_mm": 226,
            "closed_loop_sensors": True,
            "mount_roles": ["motor_1", "motor_2", "motor_3", "motor_4", "controller", "battery", "imu"],
        },
        "mecanum": {
            "label": "Mecanum omnidirectional base",
            "shape": "horizontal_plate",
            "motor_count": 4,
            "extra_parts": ["4× mecanum wheels (100mm)"],
            "kinematics": "mecanum",
            "wheel_diameter_mm": 100,
            "wheelbase_mm": 180,
            "track_mm": 240,
            "mount_roles": ["motor_fl", "motor_fr", "motor_rl", "motor_rr", "controller", "battery"],
        },
        "static": {
            "label": "Static bench (no motion)",
            "shape": None,
            "motor_count": 0,
            "kinematics": "static",
            "note": "Parts stay wherever they are placed; no assembly or driving.",
        },
    }
    return {
        "archetypes": archetypes,
        "how_to_apply": "Call apply_assembly_archetype(archetype_id, overrides?) to push a spec to the simulator. "
                        "You can also call set_assembly_spec with a fully custom AssemblySpec if none of the "
                        "presets match (e.g. a robotic arm, hexapod, custom chassis shape).",
    }


# ---------------------------------------------------------------------------
# apply_assembly_archetype
# ---------------------------------------------------------------------------


@mcp.tool()
async def apply_assembly_archetype(
    archetype_id: Annotated[
        str,
        "Archetype id from describe_assembly_archetypes (e.g. 'self_balancer', '2wd_rover', 'quadcopter').",
    ],
    overrides: Annotated[
        dict[str, Any] | None,
        "Optional partial AssemblySpec to deep-merge over the preset (e.g. bindings, wheel size, origin).",
    ] = None,
) -> dict[str, Any]:
    """
    Build an AssemblySpec from a named archetype, with optional overrides, and
    return the spec JSON. The Wireup/host side must post this to the embedded
    Velxio iframe as `{ type: 'wireup:apply_archetype', archetype, overrides }`
    to actually lay the bench out — the MCP server cannot reach the browser
    directly. For convenience this tool also returns the ready-to-post message.

    Use this after you have placed the board + motors + wheels + sensors on the
    diagram but BEFORE running the firmware, so the scene assembles into the
    requested shape as soon as the live view mounts.
    """
    known = {
        "2wd_rover", "smart_car", "car", "4wd_rover", "tank",
        "self_balancer", "balancer", "segway", "quadcopter", "drone",
        "mecanum", "static", "bench",
    }
    if archetype_id not in known:
        return {
            "ok": False,
            "error": f"Unknown archetype '{archetype_id}'. "
                     f"Known ids: {sorted(known)}",
        }

    spec = _archetype_spec(archetype_id)
    if overrides:
        spec = _deep_merge(spec, overrides)

    return {
        "ok": True,
        "archetype_id": archetype_id,
        "spec": spec,
        "post_to_iframe": {
            "type": "wireup:apply_archetype",
            "archetype": archetype_id,
            "overrides": overrides or {},
        },
    }


# ---------------------------------------------------------------------------
# set_assembly_spec
# ---------------------------------------------------------------------------


@mcp.tool()
async def set_assembly_spec(
    spec: Annotated[
        dict[str, Any],
        "A full AssemblySpec object (see "
        "external/velxio/frontend/src/scene3d/assembly/assemblyTypes.ts).",
    ],
) -> dict[str, Any]:
    """
    Validate and echo a fully custom AssemblySpec, returning the ready-to-post
    message to send to the Velxio iframe. Use this for archetypes not in the
    preset list (robotic arm, hexapod, custom chassis shape, boxed robot, …).

    Required top-level keys vary by model; the validator ensures at minimum
    that a kinematics model is declared.
    """
    if not isinstance(spec, dict):
        return {"ok": False, "error": "spec must be a JSON object."}
    kin = spec.get("kinematics")
    if not kin or not isinstance(kin, dict) or not kin.get("model"):
        return {"ok": False, "error": "spec.kinematics.model is required (e.g. 'differential_drive', 'inverted_pendulum', 'quadcopter', 'mecanum', 'static')."}
    return {
        "ok": True,
        "spec": spec,
        "post_to_iframe": {"type": "wireup:set_assembly", "spec": spec},
    }


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    import copy
    out = copy.deepcopy(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def _archetype_spec(arch: str) -> dict[str, Any]:
    # Mirrors frontend/src/scene3d/assembly/archetypes.ts (kept in sync by hand
    # so the MCP tool can answer without booting the Vite frontend).
    WHEEL = {"diameterMm": 65, "widthMm": 26, "tireColor": "#1a1a1a", "color": "#b5b5b5"}
    if arch in ("2wd_rover", "smart_car", "car"):
        return {
            "archetype": "2wd_rover",
            "chassis": {
                "shape": "horizontal_plate",
                "size": {"x": 250, "y": 2, "z": 150},
                "thickness": 2,
                "color": "#2b6cff",
                "label": "2WD acrylic rover deck",
                "mounts": [
                    {"role": "motor_left",  "at": {"x": -70, "y": 16, "z":  65}, "rotY": 90},
                    {"role": "motor_right", "at": {"x": -70, "y": 16, "z": -65}, "rotY": 90},
                    {"role": "wheel_left",  "at": {"x": -70, "y": 16, "z":  82}},
                    {"role": "wheel_right", "at": {"x": -70, "y": 16, "z": -82}},
                    {"role": "caster_front","at": {"x": 110, "y": 13, "z": 0}},
                    {"role": "controller",  "at": {"x": -30, "y": 4, "z": 0}},
                    {"role": "battery",     "at": {"x":  60, "y": 4, "z": 0}},
                    {"role": "sensor_front","at": {"x": 120, "y": 18, "z": 0}},
                    {"role": "passenger",   "at": {"x": -60, "y": 25, "z": 0}},
                ],
            },
            "wheel": WHEEL,
            "kinematics": {"model": "differential_drive", "wheelbaseMm": 130, "deadbandRps": 0.05},
            "origin": {"x": -100, "y": 5, "z": 300},
            "rotYDeg": 0,
        }
    if arch in ("self_balancer", "balancer", "segway"):
        return {
            "archetype": "self_balancer",
            "chassis": {
                "shape": "vertical_plate",
                "size": {"x": 80, "y": 200, "z": 2},
                "thickness": 2,
                "color": "#ff6f00",
                "label": "Self-balancing 2-wheel chassis",
                "mounts": [
                    {"role": "motor_left",  "at": {"x": -10, "y": 10, "z": -12}},
                    {"role": "motor_right", "at": {"x": -10, "y": 10, "z":  12}},
                    {"role": "wheel_left",  "at": {"x": -10, "y": 10, "z": -32}, "rotY": 90},
                    {"role": "wheel_right", "at": {"x": -10, "y": 10, "z":  32}, "rotY": 90},
                    {"role": "imu",         "at": {"x": 0,   "y": 150, "z": 6}},
                    {"role": "battery",     "at": {"x": 10,  "y": 30,  "z": -6}},
                    {"role": "controller",  "at": {"x": -5,  "y": 90,  "z": 6}},
                    {"role": "sensor_front","at": {"x": 40,  "y": 90,  "z": 0}},
                ],
            },
            "wheel": {"diameterMm": 85, "widthMm": 20, "tireColor": "#1a1a1a"},
            "kinematics": {
                "model": "inverted_pendulum", "wheelbaseMm": 64, "deadbandRps": 0.02,
                "gravity": 9810, "balancePointDeg": 0, "maxTiltDeg": 45,
                "closedLoopSensors": True,
            },
            "sensors": [{"role": "imu"}, {"role": "encoder_left"}, {"role": "encoder_right"}],
            "origin": {"x": 0, "y": 0, "z": 300},
            "rotYDeg": 0,
        }
    if arch in ("quadcopter", "drone"):
        return {
            "archetype": "quadcopter",
            "chassis": {
                "shape": "frame",
                "size": {"x": 250, "y": 20, "z": 250},
                "thickness": 4, "color": "#222222",
                "label": "Quadcopter X-frame",
                "mounts": [
                    {"role": "motor_1", "at": {"x":  80, "y": 14, "z":  80}},
                    {"role": "motor_2", "at": {"x":  80, "y": 14, "z": -80}},
                    {"role": "motor_3", "at": {"x": -80, "y": 14, "z": -80}},
                    {"role": "motor_4", "at": {"x": -80, "y": 14, "z":  80}},
                    {"role": "controller", "at": {"x": 0, "y": 6, "z": 0}},
                    {"role": "battery", "at": {"x": -20, "y": 2, "z": 0}},
                    {"role": "imu", "at": {"x": 0, "y": 10, "z": 0}},
                ],
            },
            "wheel": {"diameterMm": 127, "widthMm": 8, "tireColor": "#1a1a1a", "color": "#555555"},
            "kinematics": {
                "model": "quadcopter", "wheelbaseMm": 226, "deadbandRps": 0.5,
                "gravity": 9810, "liftK": 0.003, "massKg": 0.8, "closedLoopSensors": True,
            },
            "sensors": [{"role": "imu"}],
            "origin": {"x": 0, "y": 80, "z": 300},
            "rotYDeg": 0,
        }
    if arch in ("4wd_rover", "tank"):
        return {
            "archetype": "4wd_rover",
            "chassis": {
                "shape": "horizontal_plate", "size": {"x": 260, "y": 3, "z": 180},
                "thickness": 3, "color": "#2e7d32", "label": "4WD off-road chassis",
                "mounts": [
                    {"role": "motor_fl", "at": {"x":  90, "y": 18, "z":  80}, "rotY": 90},
                    {"role": "motor_fr", "at": {"x":  90, "y": 18, "z": -80}, "rotY": 90},
                    {"role": "motor_rl", "at": {"x": -90, "y": 18, "z":  80}, "rotY": 90},
                    {"role": "motor_rr", "at": {"x": -90, "y": 18, "z": -80}, "rotY": 90},
                    {"role": "controller", "at": {"x": 0, "y": 4, "z": 0}},
                    {"role": "battery", "at": {"x": -50, "y": 4, "z": 0}},
                    {"role": "sensor_front", "at": {"x": 125, "y": 22, "z": 0}},
                ],
            },
            "wheel": {"diameterMm": 80, "widthMm": 30, "tireColor": "#1a1a1a"},
            "kinematics": {"model": "differential_drive", "wheelbaseMm": 160, "trackMm": 180, "deadbandRps": 0.05},
            "origin": {"x": -100, "y": 5, "z": 300},
        }
    if arch == "mecanum":
        return {
            "archetype": "mecanum",
            "chassis": {
                "shape": "horizontal_plate", "size": {"x": 300, "y": 3, "z": 200},
                "thickness": 3, "color": "#455a64", "label": "Mecanum omnidirectional base",
                "mounts": [
                    {"role": "motor_fl", "at": {"x":  120, "y": 20, "z":  90}, "rotY": 90},
                    {"role": "motor_fr", "at": {"x":  120, "y": 20, "z": -90}, "rotY": 90},
                    {"role": "motor_rl", "at": {"x": -120, "y": 20, "z":  90}, "rotY": 90},
                    {"role": "motor_rr", "at": {"x": -120, "y": 20, "z": -90}, "rotY": 90},
                    {"role": "controller", "at": {"x": 0, "y": 4, "z": 0}},
                    {"role": "battery", "at": {"x": -60, "y": 4, "z": 0}},
                ],
            },
            "wheel": {"diameterMm": 100, "widthMm": 36, "tireColor": "#333333"},
            "kinematics": {"model": "mecanum", "wheelbaseMm": 180, "trackMm": 240, "deadbandRps": 0.05},
            "origin": {"x": -100, "y": 5, "z": 300},
        }
    # static / bench
    return {"archetype": "static_bench", "kinematics": {"model": "static"}}
