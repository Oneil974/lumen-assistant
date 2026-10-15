import asyncio
import contextlib
import importlib.util
import io
from pathlib import Path
import time
import unittest

time.ticks_ms = lambda: 1234
time.ticks_diff = lambda a, b: a-b
spec = importlib.util.spec_from_file_location('m5_agents', Path(__file__).resolve().parents[1] / 'm5fire-orb/agents.py')
agents = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agents)

class Reader:
    def __init__(self, data): self.data = data
    async def read(self, size):
        result, self.data = self.data[:size], self.data[size:]
        return result

class SpriteTests(unittest.TestCase):
    def test_valid_sprite_and_recovery(self):
        deck = agents.Deck()
        deck.sprite_errors['a1'] = 'failed'
        asyncio.run(deck.receive_sprite(Reader(b'\x00\x01'*4), {'size':8,'w':2,'h':2,'agent_id':'a1','frame':0}))
        self.assertEqual(deck.frames[('a1',0)][:2], (2,2))
        self.assertNotIn('a1',deck.sprite_errors)

    def test_invalid_dimensions_consume_payload(self):
        deck, reader = agents.Deck(), Reader(b'12345678NEXT')
        with contextlib.redirect_stdout(io.StringIO()):
            asyncio.run(deck.receive_sprite(reader, {'size':8,'w':3,'h':2,'agent_id':'a1'}))
        self.assertEqual(reader.data,b'NEXT')
        self.assertEqual(deck.frames,{})

    def test_interrupted_transfer_is_reported(self):
        with self.assertRaisesRegex(OSError,'interrompu'):
            asyncio.run(agents.Deck().receive_sprite(Reader(b'123'), {'size':8,'w':2,'h':2}))

    def test_drawing_failure_is_logged_once_and_success_clears_it(self):
        class Canvas:
            fail = True
            def pushImage(self,*args):
                if self.fail: raise RuntimeError('unsupported format')
        canvas, errors, log = Canvas(), {}, io.StringIO()
        with contextlib.redirect_stdout(log):
            for _ in range(2):
                self.assertFalse(agents._push(canvas,0,0,(2,2,bytearray(8)),errors,'a1'))
        self.assertEqual(log.getvalue().count('echec pushImage'),1)
        canvas.fail = False
        self.assertTrue(agents._push(canvas,0,0,(2,2,bytearray(8)),errors,'a1'))
        self.assertNotIn('a1',errors)

if __name__ == '__main__': unittest.main()
