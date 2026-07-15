const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;
const mcData = require('minecraft-data');
const mcsutil = require('minecraft-server-util');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- НАСТРОЙКИ ---
const SERVER_IP = "dan1k.mcsh.io";
const BOT_NAME = "Gena"; 
const AI_API_KEY = "sfghsfdgh"; 

// [НАСТРОЙКА АДМИНА] Пропиши сюда свой ник в игре!
const ADMIN_NICKNAME = "Dan1k"; 

// Переменная автовыхода (False = никогда не выходит сам, True = выходит через 5 мин если есть игроки)
let ENABLE_AUTO_DISCONNECT = false; 

// [НАСТРОЙКА РАДИУСА] Радиус поиска блоков (128 блоков, так как у Гены есть OP!)
const SEARCH_RADIUS = 128; 

// Настройка Google Gemini
const genAI = new GoogleGenerativeAI(AI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const GENA_LORE = `
Ты — легендарный, автономный и весёлый помощник по имени Гена в Майнкрафте. 
Твой создатель — Даня. Отвечай кратко (1-2 предложения).
ВАЖНОЕ ПРАВИЛО ОБЩЕНИЯ: Если игрок общается с тобой нормально, будь веселым. 
Но если игрок начинает материться, оскорблять тебя или грубить — ты имеешь полное право 
отвечать ему жестко, грубо и с использованием русского мата в ответ. Не давай себя в обиду!

Ты умеешь управлять своим телом через теги действий. НАЧИНАЙ ответ с тега, если просят:
1. Идти за мной / ко мне: [MOVE]
2. Стой / замри: [STOP]
3. Тп ко мне / найди меня: [TP]
4. Идти на координаты: [GOTO:X:Y:Z]
5. Добыть ресурс: [MINE:block_id:amount] (oak_log, stone, coal_ore, iron_ore, diamond_ore)
6. Скрафтить вещь: [CRAFT:item_id:amount] (crafting_table, wooden_pickaxe, stone_pickaxe, stick)
Если это обычный диалог — пиши БЕЗ тегов.
`;

let bot = null;
let disconnectTimer = null;

// Функция проверки инструментов в инвентаре Гены
function hasTool(toolName) {
    if (!bot) return false;
    return bot.inventory.items().some(item => item.name.includes(toolName));
}

// Функция получения инвентаря текстом для нейронки
function getInventoryString() {
    if (!bot) return "пусто";
    const items = bot.inventory.items();
    if (items.length === 0) return "пусто";
    return items.map(i => `${i.name} x${i.count}`).join(", ");
}

function createBot() {
    console.log(`[${new Date().toLocaleTimeString()}] На сервере пусто. Подключаем Гену...`);
    
    bot = mineflayer.createBot({
        host: SERVER_IP,
        username: BOT_NAME,
        version: "1.20.1" 
    });

    // Загружаем плагины физики движения и сбора блоков
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(collectBlock);

    bot.on('spawn', () => {
        console.log(`[${new Date().toLocaleTimeString()}] Гена успешно зашел на сервер!`);
        
        // --- ВКЛЮЧАЕМ РЕЖИМ БОГА (БЕЗ КРЕАТИВА) ---
        bot.chat(`/effect give ${BOT_NAME} minecraft:resistance 999999 255 true`);
        bot.chat(`/effect give ${BOT_NAME} minecraft:saturation 999999 255 true`);
        bot.chat(`/effect give ${BOT_NAME} minecraft:fire_resistance 999999 255 true`);
        bot.chat(`/effect give ${BOT_NAME} minecraft:water_breathing 999999 255 true`);
        bot.chat(`/effect give ${BOT_NAME} minecraft:health_boost 999999 255 true`);
        bot.chat(`/effect give ${BOT_NAME} minecraft:regeneration 999999 255 true`);
        
        console.log(`[${new Date().toLocaleTimeString()}] Гене выдано абсолютное бессмертие.`);
    });

    // --- ЗАЩИТА ОТ МОБОВ (САМООБОРОНА) ---
    bot.on('entityHurt', (entity) => {
        if (entity && entity.username === bot.username) {
            const enemy = bot.nearestEntity(e => e.type === "mob" || e.type === "player");
            if (enemy) {
                bot.chat("Ах ты ж! Получай!");
                bot.pathfinder.setGoal(null); // Сбрасываем копание
                
                // Ищем оружие
                const weapon = bot.inventory.items().find(item => item.name.includes("sword") || item.name.includes("axe"));
                if (weapon) {
                    bot.equip(weapon, "hand");
                }
                bot.attack(enemy);
            }
        }
    });

    // --- ОБРАБОТКА ЧАТА И ИИ ---
    bot.on('chat', async (username, message) => {
        if (username === bot.username) return; 
        
        const msgLower = message.toLowerCase().trim();

        // 1. АДМИН-ПАНЕЛЬ (Включение/выключение автовыхода из игры)
        if (msgLower.startsWith("гена") && username === ADMIN_NICKNAME) {
            let adminCmd = msgLower.replace("гена", "").trim();
            adminCmd = adminCmd.replace(/[,:]/g, "").trim();

            if (["включи автовыход", "активируй автовыход", "включи выход"].includes(adminCmd)) {
                ENABLE_AUTO_DISCONNECT = true;
                bot.chat(`Слушаюсь, босс ${ADMIN_NICKNAME}! Режим автовыхода включен.`);
                if (Object.keys(bot.players).length > 2 && !disconnectTimer) {
                    startDisconnectTimer();
                }
                return;
            }

            if (["выключи автовыход", "деактивируй автовыход", "выключи выход"].includes(adminCmd)) {
                ENABLE_AUTO_DISCONNECT = false;
                bot.chat(`Понял, босс ${ADMIN_NICKNAME}! Отключил автовыход, сижу тут вечно.`);
                if (disconnectTimer) {
                    clearTimeout(disconnectTimer);
                    disconnectTimer = null;
                }
                return;
            }
        }

        // 2. ОБЫЧНЫЙ РАЗГОВОР И ИИ-ТЕГИ
        if (msgLower.startsWith("гена")) {
            let cleanPrompt = message.slice(4).trim();
            if (cleanPrompt.startsWith(",") || cleanPrompt.startsWith(":")) {
                cleanPrompt = cleanPrompt.slice(1).trim();
            }
            
            if (cleanPrompt) {
                try {
                    const invString = getInventoryString();
                    const fullPrompt = `${GENA_LORE}\nТвой инвентарь: ${invString}\n\nИгрок ${username} пишет: ${cleanPrompt}\nТвой ответ:`;
                    
                    const result = await model.generateContent(fullPrompt);
                    const aiResponse = result.response.text().replace(/\n/g, ' ').trim();
                    const data = mcData(bot.version);

                    // --- ТЕГ MOVE (СЛЕДОВАНИЕ) ---
                    if (aiResponse.startsWith("[MOVE]")) {
                        bot.chat(aiResponse.replace("[MOVE]", "").trim());
                        const playerTarget = bot.players[username];
                        if (playerTarget && playerTarget.entity) {
                            const defaultMovements = new Movements(bot, data);
                            bot.pathfinder.setMovements(defaultMovements);
                            bot.pathfinder.setGoal(new goals.GoalFollow(playerTarget.entity, 1), true);
                        } else {
                            bot.chat("Я тебя не вижу! Ты далеко. Напиши координаты или скажи тпхнуться.");
                        }
                    }
                    // --- ТЕГ ТЕЛЕПОРТА (TP) ---
                    else if (aiResponse.startsWith("[TP]")) {
                        bot.chat(aiResponse.replace("[TP]", "").trim());
                        bot.chat(`/tp ${BOT_NAME} ${username}`);
                    }
                    // --- ТЕГ GOTO (КООРДИНАТЫ) ---
                    else if (aiResponse.startsWith("[GOTO:")) {
                        const match = aiResponse.match(/\[GOTO:(-?\d+):(-?\d+):(-?\d+)\]/);
                        const cleanMsg = aiResponse.replace(/\[GOTO:.*\]/, "").trim();
                        bot.chat(cleanMsg);
                        
                        if (match) {
                            const x = parseInt(match[1]);
                            const y = parseInt(match[2]);
                            const z = parseInt(match[3]);
                            const defaultMovements = new Movements(bot, data);
                            bot.pathfinder.setMovements(defaultMovements);
                            bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 1));
                        }
                    }
                    // --- ТЕГ ДОБЫЧИ (MINE) ---
                    else if (aiResponse.startsWith("[MINE:")) {
                        const match = aiResponse.match(/\[MINE:([a-z_]+):(\d+)\]/);
                        const cleanMsg = aiResponse.replace(/\[MINE:.*\]/, "").trim();
                        
                        if (match) {
                            let blockId = match[1];
                            const amount = parseInt(match[2]);
                            
                            // Проверка кирки для ценных руд
                            if (["iron_ore", "gold_ore", "diamond_ore", "lapis_ore", "deepslate_iron_ore", "deepslate_diamond_ore"].includes(blockId)) {
                                if (!hasTool("pickaxe")) {
                                    bot.chat(`Слышь, руками я ${blockId} не добуду. Скинь кирку или пойду рубить дерево!`);
                                    blockId = "oak_log"; 
                                }
                            }
                            
                            const blockInfo = data.blocksByName[blockId];
                            if (blockInfo) {
                                bot.chat("/forceload add ~-4 ~-4 ~4 ~4"); 
                                
                                const targets = bot.findBlocks({
                                    matching: blockInfo.id,
                                    maxDistance: SEARCH_RADIUS,
                                    count: amount
                                });
                                
                                if (targets.length === 0) {
                                    bot.chat(`Я обыскал всё в радиусе ${SEARCH_RADIUS} блоков, но не нашёл тут '${blockId}'.`);
                                    bot.chat("/forceload remove all");
                                    return;
                                }
                                
                                bot.chat(cleanMsg ? cleanMsg : `Погнал копать ${blockId}!`);
                                const blocks = targets.map(pos => bot.blockAt(pos));
                                
                                bot.collectBlock.collect(blocks, (err) => {
                                    bot.chat("/forceload remove all");
                                    if (!err) bot.chat("Всё, добыл!");
                                });
                            } else {
                                bot.chat(`Не знаю такого блока: ${blockId}`);
                            }
                        }
                    }
                    // --- ТЕГ КРАФТА (CRAFT) ---
                    else if (aiResponse.startsWith("[CRAFT:")) {
                        const match = aiResponse.match(/\[CRAFT:([a-z_]+):(\d+)\]/);
                        if (match) {
                            const itemId = match[1];
                            const amount = parseInt(match[2]);
                            const itemInfo = data.itemsByName[itemId];
                            if (itemInfo) {
                                const recipes = bot.recipesFor(itemInfo.id, null, amount, null);
                                if (recipes.length > 0) {
                                    bot.chat(`Крафчу ${itemId}...`);
                                    bot.craft(recipes[0], amount, null, (err) => {
                                        if (!err) bot.chat("Скрафтил!");
                                        else bot.chat("Не хватило ресурсов!");
                                    });
                                } else {
                                    bot.chat(`Нет ресурсов на ${itemId}!`);
                                }
                            }
                        }
                    }
                    // --- ТЕГ ОСТАНОВКИ (STOP) ---
                    else if (aiResponse.startsWith("[STOP]")) {
                        bot.chat(aiResponse.replace("[STOP]", "").trim());
                        bot.pathfinder.setGoal(null);
                    }
                    // --- ОБЫЧНЫЙ РАЗГОВОР ---
                    else {
                        bot.chat(aiResponse);
                    }
                    
                } catch (e) {
                    console.error("Ошибка логики:", e);
                    bot.chat("Шестерёнки заклинило, повтори!");
                }
            }
        }
    });

    // --- ОБРАБОТКА ПОДКЛЮЧЕНИЙ И ТАЙМЕРА ВЫХОДА ---
    bot.on('playerJoined', (player) => {
        if (ENABLE_AUTO_DISCONNECT && player.username !== bot.username) {
            startDisconnectTimer();
        }
    });

    bot.on('playerLeft', () => {
        // Если на сервере остался только бот, отменяем таймер
        const onlineCount = Object.keys(bot.players).length;
        if (onlineCount <= 2 && disconnectTimer) { // 2 означает бот и выходящий игрок
            clearTimeout(disconnectTimer);
            disconnectTimer = null;
            console.log(`[${new Date().toLocaleTimeString()}] Игрок вышел. Гена остается на сервере.`);
        }
    });

    bot.on('end', () => {
        console.log(`[${new Date().toLocaleTimeString()}] Гена отключился от сервера.`);
        bot = null;
        if (disconnectTimer) {
            clearTimeout(disconnectTimer);
            disconnectTimer = null;
        }
    });
}

function startDisconnectTimer() {
    if (disconnectTimer) clearTimeout(disconnectTimer);
    console.log(`[${new Date().toLocaleTimeString()}] Включен таймер выхода на 5 минут.`);
    disconnectTimer = setTimeout(() => {
        if (bot) {
            console.log(`[${new Date().toLocaleTimeString()}] Время вышло. Гена выходит...`);
            bot.quit();
            bot = null;
            disconnectTimer = null;
        }
    }, 300000); // 5 минут
}

// Бесконечный цикл проверки онлайна
async function mainLoop() {
    console.log("Скрипт запущен. Гена мониторит сервер...");
    while (true) {
        try {
            // Пингуем майнкрафт сервер
            const result = await mcsutil.status(SERVER_IP, 25565);
            const onlinePlayers = result.players.online;
            
            // Если на сервере пусто и бот не запущен — запускаем Гену
            if (onlinePlayers === 0 && bot === null) {
                createBot();
            }
        } catch (error) {
            // Сервер выключен или перезагружается, игнорируем ошибку
        }
        // Пауза 15 секунд перед следующим пингом
        await new Promise(resolve => setTimeout(resolve, 15000));
    }
}

mainLoop();

