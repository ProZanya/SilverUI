const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises'); 
const path = require('path');
const axios = require('axios');
const unzipper = require('unzipper');
const { pipeline } = require('stream/promises');
const tar = require('tar');

process.on('uncaughtException', (error) => {
    console.error('КРИТИЧЕСКАЯ ОШИБКА - необработанное исключение:', error);
    // Можно добавить логику для graceful shutdown
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('КРИТИЧЕСКАЯ ОШИБКА - необработанный Promise rejection:', reason);
});

/*
async function initializeDirs() {
	try {
			await fsp.mkdir(SOURCE_DIR, { recursive: true });
			await fsp.mkdir(DEST_DIR, { recursive: true });
			console.log(`Родительские директории ${SOURCE_DIR} и ${DEST_DIR} готовы.`);
		} catch (err) {
			console.error('Ошибка при подготовке директорий:', err);
		}
	};
*/	
// =========================================================
// ЗАГРУЗКА КОНФИГУРАЦИИ
// =========================================================
const CONFIG = {};
try {
    // Укажите путь к вашему конфигу. 
    const configPath = path.join(__dirname, 'config.ini');
    
    console.log(`Загрузка конфигурации из: ${configPath}`);
    const configFile = fs.readFileSync(configPath, 'utf8');
    
    configFile.split(`\n`).forEach(line => {
        line = line.trim();
        if (line.startsWith('#') || line === '') {
            return;
        }
        
        // Парсим KEY=VALUE
        const [key, value] = line.split('=');
        if (key && value) {
            CONFIG[key.trim()] = value.trim();
        }
    });

    //Преобразуем типы (в файле все - строки)
    CONFIG.PORT = parseInt(CONFIG.PORT, 10) || 3000;
    CONFIG.DOWNLOAD_ENABLED = CONFIG.DOWNLOAD_ENABLED === 'true';
    CONFIG.WARN_ON_CLEAR = CONFIG.WARN_ON_CLEAR === 'true';

    console.log('Конфигурация успешно загружена:', {
        PORT: CONFIG.PORT,
        DOWNLOAD_ENABLED: CONFIG.DOWNLOAD_ENABLED,
        WARN_ON_CLEAR: CONFIG.WARN_ON_CLEAR
    });

} catch (error) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА: Не удалось прочитать config.ini!', error.message);
    process.exit(1); // Завершаем работу, если конфиг не найден
}

// ---------------------
// ИСПОЛЬЗУЕМ КОНФИГ ВМЕСТО КОНСТАНТ
// ---------------------
const app = express();
const port = CONFIG.PORT;
const SOURCE_DIR = CONFIG.SOURCE_DIR;
const DEST_DIR = CONFIG.DEST_DIR;
const TARGET_FILENAME = CONFIG.TARGET_FILENAME;

app.use(express.json());

// =========================================================
// Отдаем клиенту безопасные настройки
// =========================================================
app.get('/api/config', (req, res) => {
    res.json({
        success: true,
        DOWNLOAD_ENABLED: CONFIG.DOWNLOAD_ENABLED,
        WARN_ON_CLEAR: CONFIG.WARN_ON_CLEAR 
    });
});

//initializeDirs();
// =========================================================
// API 1: Получение директорий
// =========================================================
app.get('/api/get-dirs', async (req, res) => {
    try {
        console.log(`Попытка чтения директорий из: ${SOURCE_DIR}`);
        
        const entries = await fsp.readdir(SOURCE_DIR, { withFileTypes: true });
        
        const dirs = entries
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        console.log(`Найдено директорий: ${dirs.length}`);
        res.json({ success: true, files: dirs });

    } catch (error) {
        console.error(`❌ Ошибка чтения директории ${SOURCE_DIR}:`, error.message);
        res.status(500).json({ success: false, message: `Не удалось прочитать директорию. ${error.code || ''}` });
    }
});

// =========================================================
// API 2:Копирует СОДЕРЖИМОЕ в DEST_DIR
// =========================================================
app.post('/api/process-directory', async (req, res) => {
    
    const { dirname, renameFile, options } = req.body;
    const { detailed } = options;

    if (!dirname) {
        return res.status(400).json({ message: 'Имя директории не указано.' });
    }

    // Формируем пути
    const sourcePath = path.join(SOURCE_DIR, dirname);
	
    const destPath = DEST_DIR; 

    try {
        let operationMessage = '';

        // ------------------------------------
        // 1. Копируем *содержимое* директории
        // ------------------------------------
        console.log(`Копирование содержимого из ${sourcePath} в ${destPath}...`);

        // 1. Получаем список всех файлов и папок в исходной директории
        const entries = await fsp.readdir(sourcePath, { withFileTypes: true });

        // 2. Копируем каждый элемент в destPath
        for (const entry of entries) {
            const srcEntryPath = path.join(sourcePath, entry.name);
            const destEntryPath = path.join(destPath, entry.name);
            
            // fsp.cp рекурсивно скопирует и файлы, и папки
            // { force: true } перезапишет, если что-то уже существует
            await fsp.cp(srcEntryPath, destEntryPath, { recursive: true, force: true });
        }
        
        operationMessage = `Содержимое директории "${dirname}" успешно скопировано в "${DEST_DIR}".`;
        console.log(`Копирование завершено. Скопировано элементов: ${entries.length}`);

        // ------------------------------------
        // Шаг 2: Условное переименование файла
        // ------------------------------------
        if (renameFile && renameFile.trim() !== '') {
            console.log(`Запрос на переименование файла: ${renameFile}`);
            
            //Пути к файлам теперь ищутся прямо в destPath (DEST_DIR)
            const oldFilePath = path.join(destPath, renameFile); 
            const newFilePath = path.join(destPath, TARGET_FILENAME);

            try {
                // Проверяем, существует ли файл, который нужно переименовать
                await fsp.access(oldFilePath);
                
                // Переименовываем
                await fsp.rename(oldFilePath, newFilePath);
                
                operationMessage += `\nФайл "${renameFile}" в ${DEST_DIR} переименован в "${TARGET_FILENAME}".`;
                console.log('Переименование успешно.');
            } catch (renameError) {
                // Если файл не найден
                operationMessage += `\n⚠️ Файл "${renameFile}" не найден в ${DEST_DIR}, переименование не выполнено.`;
                console.warn(`Файл ${oldFilePath} не найден.`);
            }
        } else {
            operationMessage += `\nПереименование не запрашивалось.`;
        }

        if (detailed) {
            operationMessage += ' (Расширенный режим)';
        }

        res.json({ success: true, message: operationMessage });

    } catch (error) {
        console.error('Ошибка файловой операции:', error);
        res.status(500).json({ success: false, message: `Ошибка: ${error.message}.` });
    }
});

// =========================================================
// API 3: НОВЫЙ МАРШРУТ ДЛЯ ОЧИСТКИ ДИРЕКТОРИИ
// =========================================================
app.post('/api/clear-directory', async (req, res) => {
    try {
        console.log(`Получен запрос на очистку: ${DEST_DIR}`);
        
        // Получаем список всего, что есть в DEST_DIR
        const entries = await fsp.readdir(DEST_DIR);
        
        for (const entry of entries) {
            // Это позволяет fsp.rm() удалять как файлы, так и директории
            await fsp.rm(path.join(DEST_DIR, entry), { recursive: true, force: true });
        }
        const message = `Директория ${DEST_DIR} успешно очищена. Удалено элементов: ${entries.length}.`;
        console.log(message);
        res.json({ success: true, message: message });

    } catch (error) {
        console.error(`Ошибка при очистке ${DEST_DIR}:`, error);
        res.status(500).json({ success: false, message: `Ошибка при очистке: ${error.message}` });
    }
});

// =========================================================
// API 4: НОВЫЙ МАРШРУТ ДЛЯ СКАЧИВАНИЯ И РАСПАКОВКИ
// =========================================================
app.post('/api/download-and-unpack', async (req, res) => {
    
	// ПРОВЕРКА ИЗ КОНФИГА
    if (!CONFIG.DOWNLOAD_ENABLED) {
        return res.status(403).json({ 
            success: false, 
            message: 'Функция скачивания отключена администратором.' 
        });
    }
	
    const { url, dirName } = req.body;

    // 1. Валидация
    if (!url || !dirName) {
        return res.status(400).json({ success: false, message: 'URL и Имя новой директории обязательны.' });
    }

    // 2. Проверка безопасности и формирование пути
    const safeDirName = path.basename(dirName);
    if (safeDirName !== dirName) {
        return res.status(400).json({ 
            success: false, 
            message: 'Имя директории не должно содержать слэшей (/) или точек (..).' 
        });
    }

    const newDirPath = path.join(SOURCE_DIR, safeDirName);

    // 3. ⚠️ ОПРЕДЕЛЕНИЕ ТИПА АРХИВА по URL
    let archiveType = 'unknown';
    if (url.toLowerCase().endsWith('.zip')) {
        archiveType = 'zip';
    } else if (url.toLowerCase().endsWith('.tar.gz') || url.toLowerCase().endsWith('.tgz')) {
        archiveType = 'targz';
    }

    if (archiveType === 'unknown') {
        return res.status(400).json({ 
            success: false, 
            message: 'Неподдерживаемый формат архива. Поддерживаются: .zip, .tar.gz, .tgz.' 
        });
    }

    try {
        // 4. Проверяем, не существует ли уже такая директория
        try {
            await fsp.access(newDirPath);
            return res.status(400).json({ 
                success: false, 
                message: `Директория "${safeDirName}" уже существует в ${SOURCE_DIR}.` 
            });
        } catch (dirAccessError) {
            // Папки нет, это хорошо.
        }

        console.log(`Скачивание ${archiveType} архива с: ${url}`);
        
        // 5. Создание директории и скачивание
        await fsp.mkdir(newDirPath, { recursive: true });

        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'stream'
        });

        // 6. 🛠️ УСЛОВНАЯ РАСПАКОВКА
        let extractionStream;
        
        if (archiveType === 'zip') {
            // Используем unzipper для ZIP
            extractionStream = unzipper.Extract({ path: newDirPath });
            console.log('Используется unzipper...');
        } else if (archiveType === 'targz') {
            // Используем tar для TAR.GZ
            extractionStream = tar.x({ 
                C: newDirPath, // C - Change directory (распаковать в этот путь)
                strict: true   // Строгий режим
            });
            console.log('Используется tar...');
        }
        
        // 7. Перенаправляем поток скачивания в поток распаковки
        await pipeline(
            response.data,
            extractionStream
        );

        console.log('Распаковка завершена.');
        res.json({ 
            success: true, 
            message: `Архив (${archiveType}) успешно скачан и распакован в ${newDirPath}` 
        });

    } catch (error) {
        console.error('Ошибка при скачивании или распаковке:', error.message);
        
        // Попытка удалить частично созданную директорию при ошибке
        try {
            await fsp.rm(newDirPath, { recursive: true, force: true });
        } catch (cleanupError) {
            console.error('Ошибка при очистке:', cleanupError.message);
        }
        
        res.status(500).json({ 
            success: false, 
            message: `Ошибка: ${error.message}` 
        });
    }
});


// =========================================================
// ОТДАЧА ФРОНТЕНДА
// =========================================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
    console.log(`Сервер запущен на http://localhost:${port}`);
});