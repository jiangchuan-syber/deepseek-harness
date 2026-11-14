"""SDK boundary fixtures only; fake modules never open sockets or touch private inventory."""
import importlib.util
import importlib.metadata
from pathlib import Path
import sys
from types import ModuleType
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('fixture_miio_broker', Path(__file__).resolve().parents[1] / 'miio-lamp-broker.py')
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


def sdk(actual_identity=123, discovery_seconds=.04):
    clock = [0.0]
    discovered, sent, handshake_retries = [], [], []
    class Protocol:
        def __init__(self):
            self.ip = 'fixture-address'; self._device_id = b''; self._discovered = False; self._timeout = 5
        @staticmethod
        def discover(_addr=None, timeout=5):
            discovered.append(timeout); clock[0] += discovery_seconds
        def send_handshake(self, retry_count=3):
            handshake_retries.append(retry_count)
            self.discover(self.ip)
            self._device_id = actual_identity.to_bytes(4, 'big'); self._discovered = True
        def send(self, command, parameters=None, retry_count=3, **_kwargs):
            sent.append((command, parameters, retry_count, self._timeout)); return ['off']
    class Device:
        def __init__(self, *_args, **_kwargs): self._protocol = Protocol()
        @property
        def device_id(self):
            if not self._protocol._device_id: self._protocol.send_handshake()
            return int.from_bytes(self._protocol._device_id, 'big')
        def send(self, command, parameters=None, retry_count=3): return self._protocol.send(command, parameters, retry_count)
    miio, protocol = ModuleType('miio'), ModuleType('miio.miioprotocol')
    miio.Device = Device; protocol.MiIOProtocol = Protocol
    return {'miio': miio, 'miio.miioprotocol': protocol}, clock, discovered, sent, handshake_retries


class DeadlineTests(unittest.TestCase):
    def run_sdk(self, callback, actual_identity=123, discovery_seconds=.04):
        modules, clock, discovered, sent, retries = sdk(actual_identity, discovery_seconds)
        with patch.dict(sys.modules, modules), patch('importlib.metadata.version', return_value='0.5.12'), \
                patch.object(broker.time, 'perf_counter', side_effect=lambda: clock[0]):
            transport = broker.RealLamp({'localip': 'fixture-address', 'token': 'fixture'}, '123')
            callback(transport, broker.Deadline(100), discovered, sent, retries)

    def test_discovery_default_five_seconds_is_replaced_by_remaining_total_budget(self):
        def check(transport, deadline, discovered, sent, retries):
            self.assertFalse(transport.read(deadline))
            self.assertEqual(retries, [0]); self.assertAlmostEqual(discovered[0], .1)
            self.assertEqual(sent[0][:3], ('get_prop', ['power'], 0)); self.assertAlmostEqual(sent[0][3], .06)
        self.run_sdk(check)

    def test_wrong_handshake_identity_cannot_reach_a_setter(self):
        def check(transport, deadline, _discovered, sent, _retries):
            with self.assertRaisesRegex(broker.Refused, 'network_identity_changed'): transport.write(False, deadline)
            self.assertEqual(sent, [])
        self.run_sdk(check, actual_identity=124)

    def test_expired_discovery_cannot_receive_a_new_full_send_budget(self):
        def check(transport, deadline, _discovered, sent, _retries):
            with self.assertRaisesRegex(broker.Refused, 'operation_deadline'): transport.read(deadline)
            self.assertEqual(sent, [])
        self.run_sdk(check, discovery_seconds=.2)


if __name__ == '__main__': unittest.main()
