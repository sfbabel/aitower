#!/usr/bin/env python3
"""
Keyboard RGB Reactive Effects
Monitors keypresses via evdev and drives RGB effects on:
  - ASUS TUF Laptop Keyboard backlight (via OpenRGB)
  - Logitech G203 Lightsync Mouse (via OpenRGB)

Effects:
  reactive  - Flash a color on keypress, fade to idle color
  cycle     - Cycle through hues with each keypress
  heatmap   - Color shifts from cool to hot based on typing speed
  rain      - Random color per keypress

Usage:
  python3 keypress_rgb.py [--effect reactive|cycle|heatmap|rain]
                          [--flash-color R G B]
                          [--idle-color R G B]
                          [--fade-time SECONDS]
                          [--mouse]
                          [--keyboard-name NAME]
"""

import argparse
import asyncio
import colorsys
import math
import random
import signal
import sys
import time
from dataclasses import dataclass, field
from typing import Optional

import evdev
from openrgb import OpenRGBClient
from openrgb.utils import RGBColor


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def rgb_from_hsv(h: float, s: float = 1.0, v: float = 1.0) -> RGBColor:
    """Create an RGBColor from HSV (h in 0..1)."""
    r, g, b = colorsys.hsv_to_rgb(h % 1.0, s, v)
    return RGBColor(int(r * 255), int(g * 255), int(b * 255))


def lerp_color(a: RGBColor, b: RGBColor, t: float) -> RGBColor:
    """Linearly interpolate between two colors (t in 0..1)."""
    t = max(0.0, min(1.0, t))
    return RGBColor(
        int(a.red   + (b.red   - a.red)   * t),
        int(a.green + (b.green - a.green) * t),
        int(a.blue  + (b.blue  - a.blue)  * t),
    )


# ---------------------------------------------------------------------------
# Effect State
# ---------------------------------------------------------------------------

@dataclass
class EffectState:
    effect: str = "reactive"
    flash_color: RGBColor = field(default_factory=lambda: RGBColor(255, 60, 200))
    idle_color: RGBColor = field(default_factory=lambda: RGBColor(143, 0, 214))
    fade_time: float = 0.6          # seconds to fade from flash -> idle
    last_keypress: float = 0.0      # timestamp of last keypress
    keypress_count: int = 0         # total keypresses (for cycle)
    hue: float = 0.0                # current hue (for cycle mode)
    recent_times: list = field(default_factory=list)  # recent keypress timestamps
    current_color: Optional[RGBColor] = None


# ---------------------------------------------------------------------------
# Effect Calculators
# ---------------------------------------------------------------------------

def calc_reactive(state: EffectState, now: float) -> RGBColor:
    """Flash on keypress, fade back to idle."""
    elapsed = now - state.last_keypress
    if elapsed >= state.fade_time:
        return state.idle_color
    t = elapsed / state.fade_time
    # Ease-out (quadratic)
    t = 1.0 - (1.0 - t) ** 2
    return lerp_color(state.flash_color, state.idle_color, t)


def calc_cycle(state: EffectState, now: float) -> RGBColor:
    """Cycle through the hue wheel on each keypress, fade brightness."""
    elapsed = now - state.last_keypress
    if elapsed >= state.fade_time:
        return state.idle_color
    t = elapsed / state.fade_time
    brightness = 1.0 - (t * 0.5)  # fade from 1.0 to 0.5
    return rgb_from_hsv(state.hue, 1.0, brightness)


def calc_heatmap(state: EffectState, now: float) -> RGBColor:
    """Color based on typing speed: cool blue -> green -> yellow -> red."""
    # Count keypresses in the last 2 seconds
    window = 2.0
    recent = [t for t in state.recent_times if now - t < window]
    rate = len(recent) / window  # keys per second

    # Map rate to hue: 0 kps = blue (0.6), 10+ kps = red (0.0)
    max_rate = 10.0
    normalized = min(rate / max_rate, 1.0)
    hue = 0.6 * (1.0 - normalized)  # blue -> red

    # Brightness based on recency
    elapsed = now - state.last_keypress
    if elapsed >= state.fade_time * 2:
        brightness = 0.3
    else:
        brightness = 1.0 - (elapsed / (state.fade_time * 2)) * 0.7

    return rgb_from_hsv(hue, 1.0, brightness)


def calc_rain(state: EffectState, now: float) -> RGBColor:
    """Random color per keypress, fade out."""
    elapsed = now - state.last_keypress
    if elapsed >= state.fade_time:
        return state.idle_color
    t = elapsed / state.fade_time
    t = 1.0 - (1.0 - t) ** 2
    flash = rgb_from_hsv(state.hue, 1.0, 1.0)
    return lerp_color(flash, state.idle_color, t)


EFFECTS = {
    "reactive": calc_reactive,
    "cycle": calc_cycle,
    "heatmap": calc_heatmap,
    "rain": calc_rain,
}


# ---------------------------------------------------------------------------
# Device Setup
# ---------------------------------------------------------------------------

def find_keyboard(name_filter: str) -> Optional[evdev.InputDevice]:
    """Find an evdev input device matching the given name.
    Prefers devices with 'Keyboard' in the name over 'Mouse'."""
    candidates = []
    for path in evdev.list_devices():
        dev = evdev.InputDevice(path)
        if name_filter.lower() in dev.name.lower():
            # Check it actually has key events
            caps = dev.capabilities(verbose=True)
            has_keys = any("EV_KEY" in str(k) for k in caps.keys())
            if has_keys:
                candidates.append(dev)
    if not candidates:
        return None
    # Prefer devices with "keyboard" in name
    for dev in candidates:
        if "keyboard" in dev.name.lower():
            return dev
    return candidates[0]


def find_all_keyboards(name_filters: list[str]) -> list[evdev.InputDevice]:
    """Find all keyboards matching any of the given name filters."""
    keyboards = []
    for name_filter in name_filters:
        dev = find_keyboard(name_filter)
        if dev:
            keyboards.append(dev)
            print(f"  ✓ Found keyboard: {dev.name} ({dev.path})")
        else:
            print(f"  ✗ Keyboard not found: {name_filter}")
    return keyboards


def setup_openrgb(use_mouse: bool) -> tuple[Optional[object], Optional[object]]:
    """Connect to OpenRGB and find devices."""
    try:
        client = OpenRGBClient()
    except Exception as e:
        print(f"  ✗ Could not connect to OpenRGB: {e}")
        print("    Make sure OpenRGB server is running (openrgb --server)")
        return None, None

    keyboard_dev = None
    mouse_dev = None

    for dev in client.devices:
        dev_type = str(getattr(dev, 'type', '')).lower()
        name_lower = dev.name.lower()
        if not keyboard_dev and (
            "keyboard" in name_lower
            or "laptop" in name_lower
            or dev_type == "devicetype.keyboard"
            or dev_type == "devicetype.laptop"
        ):
            dev.set_mode("Direct")
            keyboard_dev = dev
            print(f"  ✓ RGB Keyboard: {dev.name}")
        elif use_mouse and not mouse_dev and (
            "mouse" in name_lower
            or "g203" in name_lower
            or "g102" in name_lower
            or "lightsync" in name_lower
            or dev_type == "devicetype.mouse"
        ):
            dev.set_mode("Direct")
            mouse_dev = dev
            print(f"  ✓ RGB Mouse: {dev.name}")

    if not keyboard_dev:
        print("  ✗ No RGB keyboard found in OpenRGB")

    return keyboard_dev, mouse_dev


# ---------------------------------------------------------------------------
# Main Loop
# ---------------------------------------------------------------------------

async def keypress_listener(keyboards: list[evdev.InputDevice], state: EffectState):
    """Listen for keypresses from all keyboards."""

    async def read_keys(device: evdev.InputDevice):
        try:
            async for event in device.async_read_loop():
                # EV_KEY = 1, value 1 = key down
                if event.type == 1 and event.value == 1:
                    now = time.monotonic()
                    state.last_keypress = now
                    state.keypress_count += 1
                    state.recent_times.append(now)

                    # Trim old timestamps (keep last 5 seconds)
                    state.recent_times = [
                        t for t in state.recent_times if now - t < 5.0
                    ]

                    # Effect-specific keypress handling
                    if state.effect == "cycle":
                        state.hue = (state.hue + 0.07) % 1.0
                    elif state.effect == "rain":
                        state.hue = random.random()
        except (OSError, IOError) as e:
            print(f"  ⚠ Lost connection to {device.name}: {e}")

    # Run all keyboard listeners concurrently
    tasks = [asyncio.create_task(read_keys(kb)) for kb in keyboards]
    await asyncio.gather(*tasks)


async def rgb_updater(
    rgb_keyboard: Optional[object],
    rgb_mouse: Optional[object],
    state: EffectState,
):
    """Periodically update RGB colors based on current effect state."""
    calc = EFFECTS[state.effect]
    update_interval = 0.033  # ~30fps
    last_color = None

    while True:
        now = time.monotonic()
        color = calc(state, now)

        # Only send updates when color actually changes (avoid USB spam)
        if last_color is None or (
            color.red != last_color.red
            or color.green != last_color.green
            or color.blue != last_color.blue
        ):
            try:
                if rgb_keyboard:
                    rgb_keyboard.set_color(color)
                if rgb_mouse:
                    rgb_mouse.set_color(color)
                last_color = color
                state.current_color = color
            except Exception as e:
                print(f"  ⚠ RGB update error: {e}")
                await asyncio.sleep(1.0)
                continue

        await asyncio.sleep(update_interval)


async def status_printer(state: EffectState):
    """Print periodic status."""
    while True:
        await asyncio.sleep(10.0)
        c = state.current_color
        color_str = f"({c.red}, {c.green}, {c.blue})" if c else "N/A"
        now = time.monotonic()
        recent = len([t for t in state.recent_times if now - t < 2.0])
        kps = recent / 2.0
        print(
            f"  [{state.effect}] "
            f"keys={state.keypress_count} "
            f"speed={kps:.1f} kps "
            f"color={color_str}"
        )


async def main():
    parser = argparse.ArgumentParser(description="Keyboard RGB reactive effects")
    parser.add_argument(
        "--effect",
        choices=["reactive", "cycle", "heatmap", "rain"],
        default="reactive",
        help="Effect mode (default: reactive)",
    )
    parser.add_argument(
        "--flash-color",
        type=int,
        nargs=3,
        default=[255, 60, 200],
        metavar=("R", "G", "B"),
        help="Flash color for reactive/rain modes (default: 255 60 200)",
    )
    parser.add_argument(
        "--idle-color",
        type=int,
        nargs=3,
        default=[143, 0, 214],
        metavar=("R", "G", "B"),
        help="Idle/base color (default: 143 0 214)",
    )
    parser.add_argument(
        "--fade-time",
        type=float,
        default=0.6,
        help="Fade duration in seconds (default: 0.6)",
    )
    parser.add_argument(
        "--mouse",
        action="store_true",
        default=True,
        help="Also apply effects to the mouse (default: true)",
    )
    parser.add_argument(
        "--no-mouse",
        action="store_true",
        help="Don't apply effects to the mouse",
    )
    parser.add_argument(
        "--keyboard-name",
        type=str,
        action="append",
        default=None,
        help="Input device name filter (can specify multiple). Default: GMK67, AT Translated",
    )

    args = parser.parse_args()

    state = EffectState(
        effect=args.effect,
        flash_color=RGBColor(*args.flash_color),
        idle_color=RGBColor(*args.idle_color),
        fade_time=args.fade_time,
    )

    use_mouse = args.mouse and not args.no_mouse
    kb_names = args.keyboard_name or ["GMK67", "AT Translated"]

    print("🌈 Keyboard RGB Reactive Effects")
    print(f"   Effect: {state.effect}")
    print(f"   Flash:  ({state.flash_color.red}, {state.flash_color.green}, {state.flash_color.blue})")
    print(f"   Idle:   ({state.idle_color.red}, {state.idle_color.green}, {state.idle_color.blue})")
    print(f"   Fade:   {state.fade_time}s")
    print()

    # Find input devices
    print("Input devices:")
    keyboards = find_all_keyboards(kb_names)
    if not keyboards:
        print("  ✗ No keyboards found! Exiting.")
        sys.exit(1)
    print()

    # Setup OpenRGB
    print("RGB devices:")
    rgb_keyboard, rgb_mouse = setup_openrgb(use_mouse)
    if not rgb_keyboard and not rgb_mouse:
        print("  ✗ No RGB devices found! Exiting.")
        sys.exit(1)
    print()

    # Set initial color
    if rgb_keyboard:
        rgb_keyboard.set_color(state.idle_color)
    if rgb_mouse:
        rgb_mouse.set_color(state.idle_color)

    print("✨ Running! Press Ctrl+C to stop.\n")

    # Graceful shutdown
    loop = asyncio.get_event_loop()

    def shutdown():
        print("\n🛑 Shutting down...")
        # Restore idle color
        try:
            if rgb_keyboard:
                rgb_keyboard.set_color(state.idle_color)
            if rgb_mouse:
                rgb_mouse.set_color(state.idle_color)
        except Exception:
            pass
        for task in asyncio.all_tasks(loop):
            task.cancel()

    loop.add_signal_handler(signal.SIGINT, shutdown)
    loop.add_signal_handler(signal.SIGTERM, shutdown)

    try:
        await asyncio.gather(
            keypress_listener(keyboards, state),
            rgb_updater(rgb_keyboard, rgb_mouse, state),
            status_printer(state),
        )
    except asyncio.CancelledError:
        pass

    print("Bye! 👋")


if __name__ == "__main__":
    asyncio.run(main())
