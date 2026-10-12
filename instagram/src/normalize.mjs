const string = value => typeof value === 'string' ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
export function normalizeUser(user) {
  if (!user || typeof user !== 'object') return null;
  return {
    id: user.pk === undefined && user.id === undefined ? null : String(user.pk ?? user.id),
    username: string(user.username), fullName: string(user.full_name),
    biography: string(user.biography), private: typeof user.is_private === 'boolean' ? user.is_private : null,
    verified: typeof user.is_verified === 'boolean' ? user.is_verified : null,
    followerCount: number(user.follower_count), followingCount: number(user.following_count),
    postCount: number(user.media_count), profilePictureUrl: string(user.profile_pic_url),
  };
}

export function normalizeMedia(media) {
  if (!media || typeof media !== 'object') return null;
  return {
    id: media.pk === undefined && media.id === undefined ? null : String(media.pk ?? media.id),
    code: string(media.code), type: number(media.media_type),
    author: normalizeUser(media.user), caption: string(media.caption?.text),
    takenAt: number(media.taken_at), likeCount: number(media.like_count),
    commentCount: number(media.comment_count),
    imageUrls: (media.image_versions2?.candidates ?? []).map(c => c.url).filter(v => typeof v === 'string'),
    videoUrls: (media.video_versions ?? []).map(v => v.url).filter(v => typeof v === 'string'),
    carousel: (media.carousel_media ?? []).map(normalizeMedia).filter(Boolean),
  };
}

