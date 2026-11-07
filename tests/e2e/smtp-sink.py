#!/usr/bin/env python3
"""Test-only SMTP server: accepts any message (plain SMTP, no TLS) and saves it as an .eml file.
Usage: smtp-sink.py <port> <output-dir>   (requires: pip install aiosmtpd)"""
import sys, time, pathlib
from aiosmtpd.controller import Controller
from aiosmtpd.smtp import AuthResult

class Saver:
    def __init__(self, out): self.out = pathlib.Path(out); self.out.mkdir(parents=True, exist_ok=True)
    async def handle_DATA(self, server, session, envelope):
        name = self.out / f"msg-{time.time_ns()}.eml"
        name.write_bytes(envelope.original_content or envelope.content)
        print(f"saved {name} from={envelope.mail_from} to={envelope.rcpt_tos}", flush=True)
        return "250 OK"

if __name__ == "__main__":
    accept_any = lambda server, session, envelope, mechanism, auth_data: AuthResult(success=True)  # test only
    c = Controller(Saver(sys.argv[2]), hostname="127.0.0.1", port=int(sys.argv[1]), auth_require_tls=False, authenticator=accept_any)
    c.start(); print("smtp sink listening", flush=True)
    try:
        while True: time.sleep(3600)
    finally: c.stop()
