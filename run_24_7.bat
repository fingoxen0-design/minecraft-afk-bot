@echo off
title Minecraft Vote and AFK Bot 24/7 Watcher
color 0A

echo ========================================================
echo   Minecraft Vote & AFK Bot (24/7 Auto-Restart Runner)
echo ========================================================
echo.

:loop
echo [%date% %time%] Bot ishga tushirilmoqda...
python bot.py
echo.
echo [%date% %time%] OGOHLANTIRISH: Bot to'xtadi yoki xatolik yuz berdi!
echo 5 soniyadan so'ng avtomatik qayta ishga tushadi...
timeout /t 5 /nobreak >nul
goto loop
