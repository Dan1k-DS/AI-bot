const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const collectBlock = require('mineflayer-collectblock').plugin;
const mcData = require('minecraft-data');
const mcsutil = require('minecraft-server-util');

// Подключаем НОВУЮ библиотеку Google Gen AI
const { GoogleGenAI } = require("@google/genai");

// --- НАСТРОЙКИ ---
const SERVER_IP = "dan1k.mcsh.io";
const BOT_NAME = "Gena"; 

// Твой НОВЫЙ ключ авторизации (Auth Key)
const AI_API_KEY = "AQ.Ab8RN6KQ6hZVHlhCH"; 

const ADMIN_NICKNAME = "Dan1k"; 
let ENABLE_AUTO_DISCONNECT = false; 
const SEARCH_RADIUS = 128; 

// Инициализация нового клиента GoogleGenAI
const ai = new GoogleGenAI({ apiKey: AI_API_KEY });

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

function hasTool(toolName) {
    if (!bot) return false;
    return bot.inventory.items().some(item => item.name.includes(toolName));
}

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
        version: "1.21.1" // Указываем точную Java-версию сервера
    });

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(collectBlock);

    bot.on('spawn', () => {
        console.log(`[${new Date().toLocaleTimeString()}] Гена успешно зашел на сервер!`);
        
        bot.chat(`/effect give ${BOT_NAME} minecraft:resistance 999999 255 true`);
        bot.chat(`/effect give ${BOT_NAME} minecraft:saturation 999999 255 true`);
        bot.chat(`/effect give ${BOT_NAME} minecraft:fire_resistance 999999 255 true`);
        bot.chat(`/effect give ${BOT_NAME} minecraft:water_breathing 999999 255 true`);
        bot.chat(`/effect give ${BOT_NAME} minecraft:health_boost 999999 255 true`);
        bot.chat(`/effect give ${BOT_NAME} minecraft:regeneration 999999 255 true`);
        
        console.log(`[${new Date().toLocaleTimeString()}] Гене выданы эффекты бессмертия.`);
    });

    bot.on('entityHurt', (entity) => {
        if (entity && entity.username === bot.username) {
            const enemy = bot.nearestEntity(e => e.type === "mob" || e.type === "player");
            if (enemy) {
                bot.chat("Ах ты ж! Получай!");
                bot.pathfinder.setGoal(null); 
                
                const weapon = bot.inventory.items().find(item => item.name.includes("sword") || item.name.includes("axe"));
                if (weapon) {
                    bot.equip(weapon, "hand");
                }
                bot.attack(enemy);
            }
        }
    });

    bot.on('chat', async (username, message) => {
        if (username === bot.username) return; 
        
        const msgLower = message.toLowerCase().trim();

        // 1. АДМИН-ПАНЕЛЬ
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

        // 2. ЛОГИКА ИИ И ТЕГИ
        if (msgLower.startsWith("гена")) {
            let cleanPrompt = message.slice(4).trim();
            if (cleanPrompt.startsWith(",") || cleanPrompt.startsWith(":")) {
                cleanPrompt = cleanPrompt.slice(1).trim();
            }
            
            if (cleanPrompt) {
                // ПРОВЕРКА НАЛИЧИЯ ТОКЕНА
                if (!AI_API_KEY || AI_API_KEY.trim() === "") {
                    bot.chat("Мой создатель забыл вставить мне API-ключ! Я ничего не понимаю.");
                    return;
                }

                try {
                    const invString = getInventoryString();
                    const fullPrompt = `${GENA_LORE}\nТвой инвентарь: ${invString}\n\nИгрок ${username} пишет: ${cleanPrompt}\nТвой ответ:`;
                    
                    // --- НОВЫЙ ИНТЕРФЕЙС ИИ INTERACTIONS API ---
                    const interaction = await ai.interactions.create({
                        model: "gemini-3.5-flash",
                        input: fullPrompt
                    });
                    
                    // Получаем текст ответа
                    const aiResponse = interaction.output_text.replace(/\n/g, ' ').trim();
                    const data = mcData(bot.version);

                    if (aiResponse.startsWith("[MOVE]")) {
                        bot.chat(aiResponse.replace("[MOVE]", "").trim());
                        const playerTarget = bot.players[username];
                        if (playerTarget && playerTarget.entity) {
                            const defaultMovements = new Movements(bot, data);
                            bot.pathfinder.setMovements(defaultMovements);
                            bot.pathfinder.setGoal(new goals.GoalFollow(playerTarget.entity, 1), true);
                        } else {
                            bot.chat("Я тебя не вижу! Напиши координаты или скажи тпхнуться.");
                        }
                    }
                    else if (aiResponse.startsWith("[TP]")) {
                        bot.chat(aiResponse.replace("[TP]", "").trim());
                        bot.chat(`/tp ${BOT_NAME} ${username}`);
                    }
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
                    else if (aiResponse.startsWith("[MINE:")) {
                        const match = aiResponse.match(/\[MINE:([a-z_]+):(\d+)\]/);
                        const cleanMsg = aiResponse.replace(/\[MINE:.*\]/, "").trim();
                        
                        if (match) {
                            let blockId = match[1];
                            const amount = parseInt(match[2]);
                            
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
                    else if (aiResponse.startsWith("[STOP]")) {
                        bot.chat(aiResponse.replace("[STOP]", "").trim());
                        bot.pathfinder.setGoal(null);
                    }
                    else {
                        bot.chat(aiResponse);
                    }
                    
                } catch (e) {
                    console.error("\n================ ОШИБКА ИИ ================");
                    console.error(e);
                    console.error("===========================================\n");
                    
                    if (e.message && e.message.includes("API key not valid")) {
                        bot.chat("Мой API-ключ не работает! Даня, проверь настройки!");
                    } else if (e.message && e.message.includes("quota")) {
                        bot.chat("У меня кончились лимиты, Гугл просит отдохнуть!");
                    } else {
                        bot.chat("Шестерёнки заклинило, посмотри ошибку в консоли хостинга!");
                    }
                }
            }
        }
    });

    bot.on('playerJoined', (player) => {
        if (ENABLE_AUTO_DISCONNECT && player.username !== bot.username) {
            startDisconnectTimer();
        }
    });

    bot.on('playerLeft', () => {
        const onlineCount = Object.keys(bot.players).length;
        if (onlineCount <= 2 && disconnectTimer) { 
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
    }, 300000);
}

async function mainLoop() {
    console.log("Скрипт запущен. Гена мониторит сервер...");
    while (true) {
        try {
            const result = await mcsutil.status(SERVER_IP, 25565);
            const onlinePlayers = result.players.online;
            
            if (onlinePlayers === 0 && bot === null) {
                createBot();
            }
        } catch (error) {
            // Сервер оффлайн
        }
        await new Promise(resolve => setTimeout(resolve, 15000));
    }
}

mainLoop();

