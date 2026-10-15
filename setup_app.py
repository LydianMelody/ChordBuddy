"""Install application dependencies into this project, never system Python."""
import os
from pathlib import Path
import subprocess
import sys
import venv


def main():
    root=Path(__file__).resolve().parent
    if sys.version_info[:2]!=(3,11):
        raise SystemExit('Please install Python 3.11 and run this setup using py -3.11 setup_app.py')
    target=root/'.venv'
    python=target/('Scripts/python.exe' if os.name=='nt' else 'bin/python')
    if not python.exists():
        venv.EnvBuilder(with_pip=True).create(target)
    subprocess.run([str(python),'-m','pip','install','--cache-dir',str(root/'.cache'/'pip'),'-r',str(root/'requirements.txt')],check=True)
    print('Chord Buddy is ready. Open Start Chord Buddy.cmd.')


if __name__=='__main__':
    main()
