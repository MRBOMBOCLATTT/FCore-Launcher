@echo off
cd /d %~dp0

echo Ставлю зависимости...
call npm install
if errorlevel 1 (
  echo npm install упал, смотри ошибку выше
  pause
  exit /b 1
)

echo Собираю...
call npm run build
if errorlevel 1 (
  echo Сборка упала, смотри ошибку выше
  pause
  exit /b 1
)

echo Готово, ищи exe в папке dist
pause
