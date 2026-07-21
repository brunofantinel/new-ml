@echo off
rem ===================================================================
rem  Sobe SO o agente do ERP (sem tunel) — para quando o app roda na
rem  MESMA rede da loja (servidor local que ja alcanca o Firebird).
rem  Nesse caso o app aponta ERP_API_URL para http://localhost:8799.
rem ===================================================================
setlocal

if exist "%~dp0definir_ambiente.bat" call "%~dp0definir_ambiente.bat"

if "%AGENT_PORT%"=="" set AGENT_PORT=8799

if "%FB_PASSWORD%"=="" (
  echo [ERRO] FB_PASSWORD nao definido. Crie definir_ambiente.bat a partir do .env.example.
  pause
  exit /b 1
)

echo Agente ERP local em http://localhost:%AGENT_PORT%
echo Deixe esta janela aberta. No .env do app coloque:
echo    ERP_API_URL=http://localhost:%AGENT_PORT%
echo    ERP_API_KEY=%AGENT_TOKEN%
echo.
py "%~dp0agente_erp.py"

endlocal
