import argparse
import logging
import socket
import sys
import webbrowser
from dataclasses import replace
from pathlib import Path

import uvicorn
from filelock import FileLock, Timeout

from backend.app import create_app
from backend.config import Settings


def main() -> None:
    parser = argparse.ArgumentParser(description="Local-only LLM prototype. Public or synthetic data only.")
    parser.add_argument("--port", type=int, help="Preferred loopback port (default 8765)")
    parser.add_argument("--no-browser", action="store_true", help="Do not open a browser automatically")
    parser.add_argument("--print-launch-url", action="store_true", help="Print the one-time PRIVATE launch URL for local automation; do not share or log it")
    arguments = parser.parse_args()
    settings = Settings.from_env()
    if arguments.port is not None:
        settings = replace(settings, port=arguments.port)
    if not (Path(__file__).resolve().parents[1] / "frontend/dist/index.html").exists():
        parser.error("Frontend not built. Run the setup script first.")
    settings.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = FileLock(settings.data_dir / "instance.lock", timeout=0)
    try:
        lock.acquire()
    except Timeout:
        parser.error("This data directory is already in use. Stop the existing server or use LOCAL_LLM_DATA_DIR.")
    listener = None
    try:
        for port in range(settings.port, min(settings.port + 20, 65536)):
            candidate = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                candidate.bind(("127.0.0.1", port))
                candidate.listen(128)
                listener = candidate
                settings = replace(settings, port=port)
                break
            except OSError:
                candidate.close()
        if listener is None:
            parser.error("No free loopback port found in the requested range.")
        app = create_app(settings)
        base_url = f"http://127.0.0.1:{settings.port}"
        launch_url = base_url + "/#setup=" + app.state.launch_code

        class LocalServer(uvicorn.Server):
            async def startup(self, sockets=None):
                await super().startup(sockets=sockets)
                if not self.started:
                    return
                print(f"Local LLM prototype: {base_url}", flush=True)
                print("Public/synthetic data only. Demo is NOT an LLM. Ctrl+C to stop.", flush=True)
                if arguments.print_launch_url:
                    print("LAUNCH_URL=" + launch_url, flush=True)
                elif not arguments.no_browser:
                    webbrowser.open(launch_url)

        logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
        logging.getLogger("httpx").setLevel(logging.WARNING)
        server = LocalServer(uvicorn.Config(app, host="127.0.0.1", port=settings.port, access_log=False, log_level="warning"))
        server.run(sockets=[listener])
    finally:
        if listener:
            listener.close()
        lock.release()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as exception:
        print(f"Startup failed: {exception}", file=sys.stderr)
        raise SystemExit(1) from None