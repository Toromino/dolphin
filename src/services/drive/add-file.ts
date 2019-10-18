import { Buffer } from 'buffer';
import * as fs from 'fs';

import * as crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import * as sharp from 'sharp';

import { publishMainStream, publishDriveStream } from '../stream';
import { deleteFile } from './delete-file';
import { fetchMeta } from '../../misc/fetch-meta';
import { GenerateVideoThumbnail } from './generate-video-thumbnail';
import { driveLogger } from './logger';
import { IImage, convertToJpeg, convertToPng, convertToGif, convertToApng } from './image-processor';
import { contentDisposition } from '../../misc/content-disposition';
import { detectMine } from '../../misc/detect-mine';
import { DriveFiles, DriveFolders, Users, Instances, UserProfiles } from '../../models';
import { InternalStorage } from './internal-storage';
import { DriveFile } from '../../models/entities/drive-file';
import { IRemoteUser, User } from '../../models/entities/user';
import { driveChart, perUserDriveChart, instanceChart } from '../chart';
import { genId } from '../../misc/gen-id';
import { isDuplicateKeyValueError } from '../../misc/is-duplicate-key-value-error';
import * as S3 from 'aws-sdk/clients/s3';
import { getS3 } from './s3';
import config from '../../config';

const logger = driveLogger.createSubLogger('register', 'yellow');

/***
 * Save file
 * @param path Path for original
 * @param name Name for original
 * @param type Content-Type for original
 * @param hash Hash for original
 * @param size Size for original
 */
async function save(file: DriveFile, path: string, name: string, type: string, hash: string, size: number): Promise<DriveFile> {
	// thunbnailを必要なら生成
	const thumb = await generateThumbnail(path, type);

	if (config.drive.storage !== 'fs') {
		//#region ObjectStorage params
		let [ext] = (name.match(/\.([a-zA-Z0-9_-]+)$/) || ['']);

		if (ext === '') {
			if (type === 'image/jpeg') ext = '.jpg';
			if (type === 'image/png') ext = '.png';
			if (type === 'image/webp') ext = '.webp';
			if (type === 'image/apng') ext = '.apng';
			if (type === 'image/vnd.mozilla.apng') ext = '.apng';
		}

		const baseUrl = config.drive.baseUrl
			|| `${ config.drive.useSSL ? 'https' : 'http' }://${ config.drive.endpoint }${ config.drive.port ? `:${config.drive.port}` : '' }/${ config.drive.bucket }`;

		// for original
		const key = `${config.drive.prefix}/${uuid()}${ext}`;
		const url = `${baseUrl}/${key}`;

		let thumbnailKey: string | null = null;
		let thumbnailUrl: string | null = null;

		//#region Uploads
		logger.info(`uploading original: ${key}`);
		const uploads = [
			upload(key, fs.createReadStream(path), type, name)
		];

		if (thumb) {
			thumbnailKey = `${config.drive.prefix}/thumbnail-${uuid()}.${thumb.ext}`;
			thumbnailUrl = `${baseUrl}/${thumbnailKey}`;

			logger.info(`uploading thumbnail: ${thumbnailKey}`);
			uploads.push(upload(thumbnailKey, thumb.data, thumb.type));
		}

		await Promise.all(uploads);
		//#endregion

		file.url = url;
		file.thumbnailUrl = thumbnailUrl;
		file.accessKey = key;
		file.thumbnailAccessKey = thumbnailKey;
		file.name = name;
		file.type = type;
		file.md5 = hash;
		file.size = size;
		file.storedInternal = false;

		return await DriveFiles.save(file);
	} else { // use internal storage
		const accessKey = uuid();
		const thumbnailAccessKey = 'thumbnail-' + uuid();

		const url = InternalStorage.saveFromPath(accessKey, path);

		let thumbnailUrl: string | null = null;

		if (thumb) {
			thumbnailUrl = InternalStorage.saveFromBuffer(thumbnailAccessKey, thumb.data);
			logger.info(`thumbnail stored: ${thumbnailAccessKey}`);
		}

		file.storedInternal = true;
		file.url = url;
		file.thumbnailUrl = thumbnailUrl;
		file.accessKey = accessKey;
		file.thumbnailAccessKey = thumbnailAccessKey;
		file.name = name;
		file.type = type;
		file.md5 = hash;
		file.size = size;

		return await DriveFiles.save(file);
	}
}

/**
 * Generate thumbnail
 * @param path Path for original
 * @param type Content-Type for original
 */
export async function generateThumbnail(path: string, type: string) {
	// #region thumbnail
	let thumbnail: IImage | null = null;

	try {
		if (['image/jpeg', 'image/webp'].includes(type)) {
			thumbnail = await convertToJpeg(path, 498, 280);
		} else if (['image/png'].includes(type)) {
			thumbnail = await convertToPng(path, 498, 280);
		} else if (['image/gif'].includes(type)) {
			thumbnail = await convertToGif(path);
		} else if (['image/apng', 'image/vnd.mozilla.apng'].includes(type)) {
			thumbnail = await convertToApng(path);
		} else if (type.startsWith('video/')) {
			try {
				thumbnail = await GenerateVideoThumbnail(path);
			} catch (e) {
				logger.error(`GenerateVideoThumbnail failed: ${e}`);
			}
		}
	} catch (e) {
		logger.warn(`thumbnail not created (an error occured)`, e);
	}
	// #endregion thumbnail

	return thumbnail;
}

/**
 * Upload to ObjectStorage
 */
async function upload(key: string, stream: fs.ReadStream | Buffer, type: string, filename?: string) {
	if (type === 'image/apng') type = 'image/png';

	const meta = await fetchMeta();

	const params = {
		Bucket: config.drive.bucket,
		Key: key,
		Body: stream,
		ContentType: type,
		CacheControl: 'max-age=31536000, immutable',
	} as S3.PutObjectRequest;

	if (filename) params.ContentDisposition = contentDisposition('inline', filename);

	const s3 = getS3(meta);

	const upload = s3.upload(params);

	await upload.promise();
}

async function deleteOldFile(user: IRemoteUser) {
	const q = DriveFiles.createQueryBuilder('file')
		.where('file.userId = :userId', { userId: user.id });

	if (user.avatarId) {
		q.andWhere('file.id != :avatarId', { avatarId: user.avatarId });
	}

	if (user.bannerId) {
		q.andWhere('file.id != :bannerId', { bannerId: user.bannerId });
	}

	q.orderBy('file.id', 'ASC');

	const oldFile = await q.getOne();

	if (oldFile) {
		deleteFile(oldFile, true);
	}
}

/**
 * Add file to drive
 *
 * @param user User who wish to add file
 * @param path File path
 * @param name Name
 * @param comment Comment
 * @param folderId Folder ID
 * @param force If set to true, forcibly upload the file even if there is a file with the same hash.
 * @param isLink Do not save file to local
 * @param url URL of source (URLからアップロードされた場合(ローカル/リモート)の元URL)
 * @param uri URL of source (リモートインスタンスのURLからアップロードされた場合の元URL)
 * @param sensitive Mark file as sensitive
 * @return Created drive file
 */
export default async function(
	user: User,
	path: string,
	name: string | null = null,
	comment: string | null = null,
	folderId: any = null,
	force: boolean = false,
	isLink: boolean = false,
	url: string | null = null,
	uri: string | null = null,
	sensitive: boolean | null = null
): Promise<DriveFile> {
	// Calc md5 hash
	const calcHash = new Promise<string>((res, rej) => {
		const readable = fs.createReadStream(path);
		const hash = crypto.createHash('md5');
		const chunks: Buffer[] = [];
		readable
			.on('error', rej)
			.pipe(hash)
			.on('error', rej)
			.on('data', chunk => chunks.push(chunk))
			.on('end', () => {
				const buffer = Buffer.concat(chunks);
				res(buffer.toString('hex'));
			});
	});

	// Get file size
	const getFileSize = new Promise<number>((res, rej) => {
		fs.stat(path, (err, stats) => {
			if (err) return rej(err);
			res(stats.size);
		});
	});

	const [hash, [mime, ext], size] = await Promise.all([calcHash, detectMine(path), getFileSize]);

	logger.info(`hash: ${hash}, mime: ${mime}, ext: ${ext}, size: ${size}`);

	// detect name
	const detectedName = name || (ext ? `untitled.${ext}` : 'untitled');

	if (!force) {
		// Check if there is a file with the same hash
		const much = await DriveFiles.findOne({
			md5: hash,
			userId: user.id,
		});

		if (much) {
			logger.info(`file with same hash is found: ${much.id}`);
			return much;
		}
	}

	//#region Check drive usage
	if (!isLink && Users.isRemoteUser(user)) {
		const usage = await DriveFiles.clacDriveUsageOf(user);

		const instance = await fetchMeta();
		const driveCapacity = 1024 * 1024 * instance.remoteDriveCapacityMb;

		logger.debug(`drive usage is ${usage} (max: ${driveCapacity})`);

		// If usage limit exceeded
		if (usage + size > driveCapacity) {
			if (Users.isLocalUser(user)) {
				throw new Error('no-free-space');
			} else {
				// (アバターまたはバナーを含まず)最も古いファイルを削除する
				deleteOldFile(user as IRemoteUser);
			}
		}
	}
	//#endregion

	const fetchFolder = async () => {
		if (!folderId) {
			return null;
		}

		const driveFolder = await DriveFolders.findOne({
			id: folderId,
			userId: user.id
		});

		if (driveFolder == null) throw new Error('folder-not-found');

		return driveFolder;
	};

	const properties: {[key: string]: any} = {};

	let propPromises: Promise<void>[] = [];

	const isImage = ['image/jpeg', 'image/gif', 'image/png', 'image/apng', 'image/vnd.mozilla.apng', 'image/webp'].includes(mime);

	if (isImage) {
		const img = sharp(path);

		// Calc width and height
		const calcWh = async () => {
			logger.debug('calculating image width and height...');

			// Calculate width and height
			const meta = await img.metadata();

			logger.debug(`image width and height is calculated: ${meta.width}, ${meta.height}`);

			properties['width'] = meta.width;
			properties['height'] = meta.height;
		};

		// Calc average color
		const calcAvg = async () => {
			logger.debug('calculating average color...');

			try {
				const info = await (img as any).stats();

				const r = Math.round(info.channels[0].mean);
				const g = Math.round(info.channels[1].mean);
				const b = Math.round(info.channels[2].mean);

				logger.debug(`average color is calculated: ${r}, ${g}, ${b}`);

				properties['avgColor'] = `rgb(${r},${g},${b})`;
			} catch (e) { }
		};

		propPromises = [calcWh(), calcAvg()];
	}

	const profile = await UserProfiles.findOne(user.id);

	const [folder] = await Promise.all([fetchFolder(), Promise.all(propPromises)]);

	let file = new DriveFile();
	file.id = genId();
	file.createdAt = new Date();
	file.userId = user.id;
	file.userHost = user.host;
	file.folderId = folder !== null ? folder.id : null;
	file.comment = comment;
	file.properties = properties;
	file.isLink = isLink;
	file.isSensitive = Users.isLocalUser(user) && profile!.alwaysMarkNsfw ? true :
		(sensitive !== null && sensitive !== undefined)
			? sensitive
			: false;

	if (url !== null) {
		file.src = url;

		if (isLink) {
			file.url = url;
			file.thumbnailUrl = url;
		}
	}

	if (uri !== null) {
		file.uri = uri;
	}

	if (isLink) {
		try {
			file.size = 0;
			file.md5 = hash;
			file.name = detectedName;
			file.type = mime;
			file.storedInternal = false;

			file = await DriveFiles.save(file);
		} catch (e) {
			// duplicate key error (when already registered)
			if (isDuplicateKeyValueError(e)) {
				logger.info(`already registered ${file.uri}`);

				file = await DriveFiles.findOne({
					uri: file.uri,
					userId: user.id
				}) as DriveFile;
			} else {
				logger.error(e);
				throw e;
			}
		}
	} else {
		file = await (save(file, path, detectedName, mime, hash, size));
	}

	logger.succ(`drive file has been created ${file.id}`);

	DriveFiles.pack(file, { self: true }).then(packedFile => {
		// Publish driveFileCreated event
		publishMainStream(user.id, 'driveFileCreated', packedFile);
		publishDriveStream(user.id, 'fileCreated', packedFile);
	});

	// 統計を更新
	driveChart.update(file, true);
	perUserDriveChart.update(file, true);
	if (file.userHost !== null) {
		instanceChart.updateDrive(file, true);
		Instances.increment({ host: file.userHost }, 'driveUsage', file.size);
		Instances.increment({ host: file.userHost }, 'driveFiles', 1);
	}

	return file;
}