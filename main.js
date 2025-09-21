const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;
const path = require('path');
const { Client } = require('discord.js-selfbot-v13');
const fs = require('fs');
const config = require('./config.json');
const https = require('https');

let mainWindow = null;
const client = new Client();

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        }
    });

    mainWindow.loadFile('index.html');
}

if (app) {
    app.on('ready', () => {
        createWindow();
        client.login(config.token);
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });

    app.on('activate', () => {
        if (mainWindow === null) {
            createWindow();
        }
    });
}

client.on('ready', () => {
    console.log(`${client.user.username} olarak giriş yapıldı!`);
    if (mainWindow) {
        const userData = {
            username: client.user.username,
            avatar: client.user.displayAvatarURL(),
            badges: client.user.flags?.toArray() || [],
            id: client.user.id,
            guildCount: client.guilds.cache.size,
            friendCount: client.relationships?.cache.size || 0
        };
        mainWindow.webContents.send('user-data-update', userData);

        const guild = client.guilds.cache.get(config.serverId);
        if (guild) {
            const serverData = {
                name: guild.name,
                icon: guild.iconURL(),
                channels: guild.channels.cache.map(channel => ({
                    id: channel.id,
                    name: channel.name,
                    type: channel.type,
                    parentId: channel.parentId
                })),
                categories: config.categories.map(categoryId => {
                    const category = guild.channels.cache.get(categoryId);
                    return {
                        id: categoryId,
                        name: category ? category.name : categoryId
                    };
                })
            };
            mainWindow.webContents.send('server-data', serverData);
        }
    }
});

async function fetchAllMessages(channel, event) {
    let messages = new Set();
    let lastId = null;
    let fetching = true;
    const MAX_MESSAGES = 10000;

    while (fetching && messages.size < MAX_MESSAGES) {
        try {
            const options = { limit: 100 };
            if (lastId) {
                options.before = lastId;
            }

            const fetchedMessages = await channel.messages.fetch(options);
            if (fetchedMessages.size === 0) {
                fetching = false;
                break;
            }

            fetchedMessages.forEach(msg => {
                if (messages.size < MAX_MESSAGES) {
                    messages.add(msg);
                }
            });
            lastId = fetchedMessages.last().id;

            event.reply('search-status', { 
                message: `${channel.name} kanalında ${messages.size} mesaj tarandı (maksimum 10000)...` 
            });

            // Eğer 10000 mesaja ulaştıysak dur
            if (messages.size >= MAX_MESSAGES) {
                fetching = false;
                break;
            }

            await new Promise(resolve => setTimeout(resolve, 100));

        } catch (error) {
            console.error(`Mesaj getirme hatası:`, error);
            fetching = false;
        }
    }

    return Array.from(messages);
}

async function downloadInParallel(files, basePath, channel, event, parallelCount = 200) {
    const chunks = [];
    const chunkSize = parallelCount;
    
    for (let i = 0; i < files.length; i += chunkSize) {
        chunks.push(files.slice(i, i + chunkSize));
    }

    let downloadedCount = 0;
    const totalFiles = files.length;

    for (const chunk of chunks) {
        await Promise.all(chunk.map(async (file) => {
            const filePath = path.join(basePath, file.fileName);

            if (fs.existsSync(filePath)) {
                event.reply('media-skipped', {
                    channelId: channel.id,
                    fileName: file.fileName,
                    channelName: channel.name,
                    categoryName: channel.parent?.name || 'Kategorisiz'
                });
                downloadedCount++;
                return;
            }

            try {
                await new Promise((resolve, reject) => {
                    const request = https.get(file.url, (response) => {
                        if (response.statusCode === 200) {
                            const fileStream = fs.createWriteStream(filePath);
                            response.pipe(fileStream);
                            
                            fileStream.on('finish', () => {
                                fileStream.close();
                                downloadedCount++;
                                event.reply('media-downloaded', {
                                    channelId: channel.id,
                                    fileName: file.fileName,
                                    channelName: channel.name,
                                    categoryName: channel.parent?.name || 'Kategorisiz',
                                    progress: `(${downloadedCount}/${totalFiles})`
                                });
                                resolve();
                            });
                        } else {
                            reject(new Error(`HTTP ${response.statusCode}`));
                        }
                    });

                    request.on('error', reject);
                    request.setTimeout(15000, () => {
                        request.destroy();
                        reject(new Error('Timeout'));
                    });
                });
            } catch (error) {
                console.error(`Dosya indirme hatası: ${file.fileName}`, error);
                event.reply('download-error', {
                    fileName: file.fileName,
                    error: error.message
                });
            }
        }));

        // Gecikme kaldırıldı - maksimum hız için
    }
}

ipcMain.on('download-media', async (event, channels) => {
    const baseDownloadPath = path.join(__dirname, 'Downloads');
    if (!fs.existsSync(baseDownloadPath)) {
        fs.mkdirSync(baseDownloadPath);
    }

    const mediaFiles = new Map();
    let totalPhotosCollected = 0;
    const MAX_PHOTOS = 10000;
    event.reply('search-status', { message: 'Medya dosyaları aranıyor...' });

    for (const channelId of channels) {
        // Eğer zaten 10000 fotoğraf toplandıysa dur
        if (totalPhotosCollected >= MAX_PHOTOS) {
            break;
        }

        const channel = client.channels.cache.get(channelId);
        if (channel) {
            try {
                event.reply('search-status', { 
                    message: `${channel.name} kanalında arama yapılıyor...` 
                });

                const messages = await fetchAllMessages(channel, event);
                const channelMedia = [];

                messages.forEach(msg => {
                    // Eğer bu kanalda toplam limiti aşacaksak dur
                    if (totalPhotosCollected >= MAX_PHOTOS) {
                        return;
                    }

                    msg.attachments.forEach(attachment => {
                        // Eğer toplam limiti aşacaksak dur
                        if (totalPhotosCollected >= MAX_PHOTOS) {
                            return;
                        }

                        const fileExt = path.extname(attachment.name).toLowerCase();
                        if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(fileExt)) {
                            channelMedia.push({
                                fileName: `${msg.id}_${attachment.name}`,
                                url: attachment.url,
                                messageId: msg.id
                            });
                            totalPhotosCollected++;
                        }
                    });
                });

                if (channelMedia.length > 0) {
                    mediaFiles.set(channelId, channelMedia);
                    event.reply('search-status', { 
                        message: `${channel.name} kanalında ${channelMedia.length} medya dosyası bulundu. Toplam: ${totalPhotosCollected}/${MAX_PHOTOS}` 
                    });
                }
            } catch (error) {
                console.error(`Kanal ${channelId} için arama hatası:`, error);
                event.reply('search-error', {
                    channelId: channelId,
                    error: error.message
                });
            }
        }
    }

    const totalFiles = totalPhotosCollected;
    
    event.reply('search-status', { 
        message: `Toplam ${totalFiles} medya dosyası bulundu (maksimum 10000). İndirme başlıyor...` 
    });

    for (const [channelId, files] of mediaFiles) {
        const channel = client.channels.cache.get(channelId);
        if (channel) {
            try {
                const category = channel.parent;
                const categoryPath = path.join(baseDownloadPath, sanitizePath(category?.name || 'Kategorisiz'));
                if (!fs.existsSync(categoryPath)) {
                    fs.mkdirSync(categoryPath);
                }

                const channelPath = path.join(categoryPath, sanitizePath(channel.name));
                if (!fs.existsSync(channelPath)) {
                    fs.mkdirSync(channelPath);
                }

                event.reply('search-status', { 
                    message: `${channel.name} kanalından dosyalar indiriliyor (${files.length} dosya)...` 
                });

                await downloadInParallel(files, channelPath, channel, event, 200);

            } catch (error) {
                console.error(`Kanal ${channelId} için hata:`, error);
                event.reply('download-error', {
                    channelId: channelId,
                    error: error.message
                });
            }
        }
    }

    event.reply('download-complete', { 
        message: 'Tüm indirmeler tamamlandı!' 
    });
});

function sanitizePath(str) {
    return str.replace(/[<>:"/\\|?*]/g, '_').trim();
} 