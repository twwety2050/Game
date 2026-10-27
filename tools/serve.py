#!/usr/bin/env python3
"""Serve the game folder over HTTP.

Browser caching is turned off, so after the folder updates a plain refresh loads the new
files. Usage:  python3 tools/serve.py [--port 8000] [--lan]
"""
import argparse
import functools
import http.server
import os
import sys

GAME_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format, *args):
        pass  # keep the terminal quiet; errors still show up in the browser


def main():
    parser = argparse.ArgumentParser(description="Serve the game folder.")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--lan", action="store_true", help="also allow other devices on your network to connect")
    args = parser.parse_args()

    handler = functools.partial(NoCacheHandler, directory=GAME_DIR)
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    try:
        server = http.server.ThreadingHTTPServer((host, args.port), handler)
    except OSError as e:
        sys.exit(f"Couldn't start the server on port {args.port} ({e.strerror}). Is it already running? Try --port 8001.")
    print(f"Serving {GAME_DIR}")
    print(f"Open http://localhost:{args.port} in your browser (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
