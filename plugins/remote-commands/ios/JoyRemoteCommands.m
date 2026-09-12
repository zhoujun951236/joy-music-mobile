#import "JoyRemoteCommands.h"
#import <UIKit/UIKit.h>
#import <MediaPlayer/MediaPlayer.h>
#import <AVFoundation/AVFoundation.h>

@interface JoyRemoteCommands ()
@property (nonatomic, assign) BOOL hasListeners;
@property (nonatomic, assign) BOOL commandsRegistered;
@end

/**
 * 只补 expo-audio 内置 MediaController 缺失的能力：
 *   1. 注册 next / previous（蓝牙耳机 / 锁屏要用，expo-audio 没注册这两个）
 *   2. 写 playbackState（expo-audio 不写，iOS 15 锁屏识别 Now Playing App 需要）
 *
 * 不再重复注册 play/pause/togglePlayPause —— 那一份完全交给 expo-audio 的 MediaController。
 * 双重注册会让 iOS 在判定「谁是当前 Now Playing App」时失败，导致歌名/封面区
 * 点击不响应、右上角不显示 App icon 而是兜底音轨动效。
 */
@implementation JoyRemoteCommands

RCT_EXPORT_MODULE(JoyRemoteCommands);

+ (BOOL)requiresMainQueueSetup {
  return YES;
}

- (NSArray<NSString *> *)supportedEvents {
  return @[
    @"RemoteNextTrack",
    @"RemotePreviousTrack",
  ];
}

- (void)startObserving {
  self.hasListeners = YES;
  __weak __typeof(self) weakSelf = self;
  dispatch_async(dispatch_get_main_queue(), ^{
    [weakSelf registerCommandsIfNeeded];
  });
}

- (void)stopObserving {
  self.hasListeners = NO;
}

RCT_EXPORT_METHOD(activate:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  __weak __typeof(self) weakSelf = self;
  dispatch_async(dispatch_get_main_queue(), ^{
    [weakSelf registerCommandsIfNeeded];
    resolve(nil);
  });
}

RCT_EXPORT_METHOD(setNowPlaying:(NSDictionary *)info
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  // 元数据（title / artist / album / artwork / duration / position）让 expo-audio
  // 的 MediaController 独占写入，避免双方互相覆盖。
  // 这里只补 playbackState —— 让 iOS 把本 App 识别为活跃的 Now Playing App。
  NSNumber *rate = info[@"rate"];
  if ([rate isKindOfClass:[NSNumber class]]) {
    [MPNowPlayingInfoCenter defaultCenter].playbackState = rate.doubleValue > 0
      ? MPNowPlayingPlaybackStatePlaying
      : MPNowPlayingPlaybackStatePaused;
  }
  resolve(nil);
}

- (void)registerCommandsIfNeeded {
  if (self.commandsRegistered) { return; }
  self.commandsRegistered = YES;

  // AudioSession 由 expo-audio 在首次 play 时激活，这里不再 setActive，避免抢时序。

  MPRemoteCommandCenter *center = [MPRemoteCommandCenter sharedCommandCenter];

  __weak __typeof(self) weakSelf = self;

  center.nextTrackCommand.enabled = YES;
  [center.nextTrackCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent * _Nonnull event) {
    [weakSelf dispatch:@"RemoteNextTrack"];
    return MPRemoteCommandHandlerStatusSuccess;
  }];

  center.previousTrackCommand.enabled = YES;
  [center.previousTrackCommand addTargetWithHandler:^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent * _Nonnull event) {
    [weakSelf dispatch:@"RemotePreviousTrack"];
    return MPRemoteCommandHandlerStatusSuccess;
  }];

  [[UIApplication sharedApplication] beginReceivingRemoteControlEvents];
}

- (void)dispatch:(NSString *)eventName {
  if (!self.hasListeners) { return; }
  [self sendEventWithName:eventName body:nil];
}

@end
