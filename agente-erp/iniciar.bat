@echo off
rem ===================================================================
rem  Sobe o agente local do ERP + o tunel Cloudflare (URL publica).
rem  Rode este arquivo na maquina da loja que enxerga o Firebird.
rem ===================================================================
setlocal

rem 1) carrega as variaveis (senha do banco, token). Crie o arquivo a partir
rem    do .env.example. Se preferir, use "setx" e apague esta linha.
if exist "%~dp0definir_ambiente.bat" call "%~dp0definir_ambiente.bat"

if "%FB_PASSWORD%"=="" (
  echo [ERRO] FB_PASSWORD nao definido. Crie definir_ambiente.bat a partir do .env.example.
  pause
  exit /b 1
)

rem 2) sobe o agente (janela separada)
start "Agente ERP" py "%~dp0agente_erp.py"

rem 3) sobe o tunel Cloudflare apontando para o agente.
rem    A URL publica (https://xxxx.trycloudflare.com) aparece nesta janela —
rem    copie ela para o ERP_API_URL no easypanel.
echo.
echo Iniciando o tunel Cloudflare... copie a URL https://...trycloudflare.com
echo e coloque em ERP_API_URL no easypanel (ERP_API_KEY = o mesmo AGENT_TOKEN).
echo.
cloudflared tunnel --url http://localhost:%AGENT_PORT%

endlocal
