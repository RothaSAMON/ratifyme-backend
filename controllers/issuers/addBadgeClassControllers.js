const { v4 } = require("uuid");
const {
    BadgeClasses,
    Issuers,
    Institutions,
    Achievements: AchievementModel,
    AchievementTypes,
    Criterias: CriteriaModel,
} = require("../../models");

const sequelize = require("../../configs/database");
const catchAsync = require("../../utils/catchAsync");
const AppError = require("../../utils/appError");
const s3 = require("../../configs/s3")

// Upload PDF to S3
const uploadToS3 = async (fileBuffer, fileName, mimetype) => {
    const uniqueFileName = `${v4()}_${fileName}`;
    const uploadParams = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: `Badge/${uniqueFileName}`,
        Body: fileBuffer,
        ContentType: mimetype,
    };

    try {
        const data = await s3.upload(uploadParams).promise();
        return data.Location;
    } catch (error) {
        console.error("Error uploading to S3:", error);
        throw error;
    }
};

exports.addBadgeClass = catchAsync(async (req, res, next) => {
    // Check if file exists before attempting to destructure it
    if (!req.file) {
        return next(new AppError("Please provide a badge image", 400));
    }

    // Destructure file properties after ensuring it exists
    const { buffer: badgeBuffer, originalname, mimetype } = req.file;
    if (!badgeBuffer || badgeBuffer.length === 0) {
        return next(new AppError("The provided image is empty", 400));
    }

    // Upload to S3
    const badgeImg = await uploadToS3(badgeBuffer, originalname, mimetype);
    if (!badgeImg) {
        return next(new AppError("Failed to upload the badge image", 500));
    }

    // Continue with the rest of your logic
    const {
        name,
        description,
        tags,
        startedDate,
        endDate,
        expiredDate,
        issuerId,
        Achievements,
        Criterias,
        institutionId, // Directly associate institutionId
    } = req.body;

    // Start transaction
    const transaction = await sequelize.transaction();
    try {
        // 1. Create BadgeClass with institutionId and issuerId directly
        const newBadgeClass = await BadgeClasses.create(
            {
                name,
                description,
                imageUrl: badgeImg,
                tags,
                startedDate,
                endDate,
                expiredDate,
                issuerId,
                institutionId,
            },
            { transaction }
        );

        // 2. Create Achievements (if applicable)
        if (Achievements && Achievements.length > 0) {
            for (const achievement of Achievements) {
                const newAchievement = await AchievementModel.create(
                    {
                        ...achievement,
                        badgeClassId: newBadgeClass.id,
                    },
                    { transaction }
                );

                if (achievement.achievementTypeId) {
                    await newAchievement.setAchievementType(achievement.achievementTypeId, {
                        transaction,
                    });
                }

                if (achievement.AchievementType) {
                    const [achievementType] = await AchievementTypes.findOrCreate({
                        where: { name: achievement.AchievementType.name },
                        defaults: achievement.AchievementType,
                        transaction,
                    });
                    await newAchievement.setAchievementType(achievementType.id, { transaction });
                }
            }
        }

        // 3. Create Criterias (if applicable)
        if (Criterias && Criterias.length > 0) {
            for (const criteria of Criterias) {
                await CriteriaModel.create(
                    {
                        ...criteria,
                        badgeClassId: newBadgeClass.id,
                    },
                    { transaction }
                );
            }
        }

        // Commit transaction
        await transaction.commit();

        // Fetch the newly created BadgeClass, including issuer and institution
        const createdBadgeClass = await BadgeClasses.findOne({
            where: { id: newBadgeClass.id },
            include: [
                {
                    model: Issuers,
                },
                {
                    model: Institutions,
                },
                {
                    model: AchievementModel,
                    include: [AchievementTypes],
                },
                {
                    model: CriteriaModel,
                },
            ],
        });

        res.status(201).json({
            status: "success",
            data: createdBadgeClass,
        });
    } catch (error) {
        // Rollback the transaction in case of errors
        console.error("Error during transaction:", error);
        await transaction.rollback();
        return next(new AppError("Error creating BadgeClass", 500));
    }
});

