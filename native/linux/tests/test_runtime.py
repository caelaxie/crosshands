"""Standard-library characterization tests for the CrossHands Linux bridge."""

import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import unittest
from unittest import mock


RUNTIME = pathlib.Path(__file__).resolve().parents[1] / "runtime.py"
SPEC = importlib.util.spec_from_file_location("crosshands_linux_runtime", RUNTIME)
runtime = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = runtime
SPEC.loader.exec_module(runtime)


class ReadinessTests(unittest.TestCase):
    def test_headless_session_is_unavailable_with_precise_issues(self):
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(
            runtime, "session_locked", return_value=False
        ), mock.patch.object(runtime, "utility", return_value=None):
            report = runtime.readiness_report()
        self.assertFalse(report["available"])
        codes = {issue["code"] for issue in report["issues"]}
        self.assertIn("missing_session_bus", codes)
        self.assertIn("missing_display", codes)
        self.assertIn("unknown_session_type", codes)

    def test_wayland_never_advertises_x11_screenshot_or_input(self):
        environment = {
            "XDG_SESSION_TYPE": "wayland",
            "WAYLAND_DISPLAY": "wayland-0",
            "XDG_RUNTIME_DIR": "/run/user/1000",
            "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus",
        }
        with mock.patch.dict(os.environ, environment, clear=True), mock.patch.object(
            runtime, "Atspi", object()
        ), mock.patch.object(runtime, "GI_IMPORT_ERROR", None), mock.patch.object(
            runtime, "session_locked", return_value=False
        ), mock.patch.object(runtime, "utility", return_value="/usr/bin/wl-copy"):
            report = runtime.readiness_report()
        self.assertTrue(report["available"])
        self.assertTrue(report["capabilities"]["semanticActions"])
        self.assertFalse(report["capabilities"]["screenshots"])
        self.assertFalse(report["capabilities"]["syntheticPointer"])
        self.assertFalse(report["capabilities"]["syntheticKeyboard"])
        self.assertFalse(report["capabilities"]["hotkey"])

    def test_x11_advertises_full_paths_only_when_dependencies_exist(self):
        environment = {
            "XDG_SESSION_TYPE": "x11",
            "DISPLAY": ":1",
            "XDG_RUNTIME_DIR": "/run/user/1000",
            "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus",
        }
        with mock.patch.dict(os.environ, environment, clear=True), mock.patch.object(
            runtime, "Atspi", object()
        ), mock.patch.object(runtime, "Gdk", object()), mock.patch.object(
            runtime, "GdkPixbuf", object()
        ), mock.patch.object(runtime, "GI_IMPORT_ERROR", None), mock.patch.object(
            runtime, "session_locked", return_value=False
        ), mock.patch.object(runtime, "utility", side_effect=lambda name: "/usr/bin/" + name):
            report = runtime.readiness_report()
        self.assertTrue(report["available"])
        self.assertTrue(report["capabilities"]["screenshots"])
        self.assertTrue(report["capabilities"]["syntheticPointer"])
        self.assertTrue(report["capabilities"]["syntheticKeyboard"])
        self.assertTrue(report["capabilities"]["hotkey"])


class ProtocolTests(unittest.TestCase):
    def test_isolated_persistent_protocol_works_from_poisoned_cwd(self):
        environment = {
            "PATH": "/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "PYTHONPATH": "/definitely/not/a/module/path",
        }
        process = subprocess.Popen(
            [sys.executable, "-I", "-u", str(RUNTIME)],
            cwd="/tmp",
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        assert process.stdin is not None
        assert process.stdout is not None
        handshake = json.loads(process.stdout.readline())
        self.assertEqual(handshake["type"], "handshake")
        self.assertEqual(handshake["provider"], "crosshands-computer-use-linux")
        process.stdin.write(
            json.dumps(
                {
                    "type": "request",
                    "requestId": "probe-1",
                    "operation": {"tool": "handshake"},
                }
            )
            + "\n"
        )
        process.stdin.flush()
        response = json.loads(process.stdout.readline())
        self.assertEqual(response["requestId"], "probe-1")
        self.assertTrue(response["ok"])
        process.stdin.close()
        process.wait(timeout=3)
        process.stdout.close()
        assert process.stderr is not None
        process.stderr.close()
        self.assertEqual(process.returncode, 0)

    def test_post_dispatch_error_is_explicit_in_response(self):
        frame = {
            "type": "request",
            "requestId": "mutation-1",
            "operation": {"tool": "click"},
        }
        with mock.patch.object(runtime, "ensure_provider_available"), mock.patch.object(
            runtime, "run_operation", side_effect=runtime.PostDispatchError("snapshot failed")
        ):
            response = runtime.handle_frame(frame)
        self.assertFalse(response["ok"])
        self.assertTrue(response["dispatched"])


class ContractBehaviorTests(unittest.TestCase):
    def test_screenshot_capture_failure_is_explicit(self):
        with mock.patch.object(runtime, "Gdk", None):
            result = runtime.capture_png(runtime.Rect(0, 0, 100, 100))
        self.assertEqual(result["error"]["code"], "screenshot_failed")
        self.assertIn("--no-screenshot", result["error"]["message"])

    def test_unicode_is_preserved_while_multiline_text_is_compacted(self):
        self.assertEqual(runtime.sanitize_text("你好\n🙂  résumé"), "你好 🙂 résumé")

    def test_secure_node_value_is_redacted_before_serialization(self):
        node = object()
        with mock.patch.object(runtime, "is_secure_node", return_value=True):
            self.assertEqual(runtime.string_value(node), "[redacted]")

    def test_window_relative_coordinates_and_stale_element_frames_are_distinct(self):
        window = runtime.Rect(100, 200, 800, 600)
        self.assertEqual(runtime.screen_point(window, x=10, y=20), (110.0, 220.0))
        with self.assertRaisesRegex(RuntimeError, "stale element frame"):
            runtime.screen_point(window, saved_element={"runtimeId": [0]}, x=10, y=20)

    def test_element_signature_rejects_rerendered_or_replaced_nodes(self):
        saved = {
            "controlType": "button",
            "name": "Save",
            "automationId": "save-button",
            "actions": ["click"],
        }
        node = object()
        with mock.patch.object(runtime, "role_of", return_value="button"), mock.patch.object(
            runtime, "name_of", return_value="Save"
        ), mock.patch.object(
            runtime, "accessible_id", return_value="save-button"
        ), mock.patch.object(runtime, "action_labels", return_value=["click"]):
            self.assertTrue(runtime.same_element_signature(node, saved))
        with mock.patch.object(runtime, "role_of", return_value="button"), mock.patch.object(
            runtime, "name_of", return_value="Save copy"
        ):
            self.assertFalse(runtime.same_element_signature(node, saved))

    def test_native_dispatch_rejects_changed_process_identity(self):
        app = object()
        with mock.patch.object(runtime, "pid_of", return_value=42):
            with self.assertRaisesRegex(RuntimeError, "stale_target"):
                runtime.assert_expected_process_identity(app, {"pid": 43})


if __name__ == "__main__":
    unittest.main()
