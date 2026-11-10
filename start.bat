@echo off
rem Запускает сайт на этом компьютере и открывает его в браузере.
rem Нужен установленный Python. Окно не закрывать, пока пользуетесь сайтом.
cd /d "%~dp0"
start "" http://localhost:5173
python -m http.server 5173
