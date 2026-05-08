@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Criando .venv e instalando dependencias...
  py -3 -m venv .venv 2>nul
  if errorlevel 1 python -m venv .venv
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt -q
  if errorlevel 1 (
    echo Falha no pip. Verifique Python instalado.
    pause
    exit /b 1
  )
)

echo.
echo  Abra no navegador: http://127.0.0.1:5000
echo  Para parar o servidor: feche esta janela ou Ctrl+C
echo.

".venv\Scripts\python.exe" app.py
echo.
pause
