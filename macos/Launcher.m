#import <Foundation/Foundation.h>
#import <ServiceManagement/ServiceManagement.h>

// A windowless native executable. All interaction stays in the existing browser UI.
int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 2 && strncmp(argv[1], "--login-", 8) == 0) {
            SMAppService *service = [SMAppService loginItemServiceWithIdentifier:@"com.tunnelstudio.login"];
            NSError *error = nil;
            BOOL ok = YES;
            if (strcmp(argv[1], "--login-enable") == 0) ok = [service registerAndReturnError:&error];
            else if (strcmp(argv[1], "--login-disable") == 0) ok = [service unregisterAndReturnError:&error];
            else if (strcmp(argv[1], "--login-status") != 0) return 2;
            NSDictionary *result = @{@"ok":@(ok), @"status":@(service.status),
                @"enabled":@(service.status == SMAppServiceStatusEnabled),
                @"requiresApproval":@(service.status == SMAppServiceStatusRequiresApproval),
                @"error":error ? error.localizedDescription : @""};
            NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
            fwrite(json.bytes, 1, json.length, stdout);
            return ok ? 0 : 1;
        }
        NSFileManager *files = [NSFileManager defaultManager];
        NSString *resources = [[NSBundle mainBundle] resourcePath];
        BOOL loginHelper = [[[NSBundle mainBundle] objectForInfoDictionaryKey:@"TunnelStudioLoginHelper"] boolValue];
        if (loginHelper) {
            NSString *mainApp = [[NSBundle mainBundle] bundlePath];
            for (int n = 0; n < 4; n++) mainApp = [mainApp stringByDeletingLastPathComponent];
            resources = [mainApp stringByAppendingPathComponent:@"Contents/Resources"];
        }
        NSString *logs = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/TunnelStudio/data/logs"];
        NSString *logPath = [logs stringByAppendingPathComponent:@"launcher.log"];
        NSError *error = nil;
        if (![files createDirectoryAtPath:logs withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:&error]) {
            fprintf(stderr, "Tunnel Studio: %s\n", error.localizedDescription.UTF8String);
            return 1;
        }
        if (![files fileExistsAtPath:logPath]) {
            [files createFileAtPath:logPath contents:nil attributes:@{NSFilePosixPermissions:@0600}];
        }
        NSFileHandle *log = [NSFileHandle fileHandleForWritingAtPath:logPath];
        if (!log) return 1;
        [log seekToEndOfFile];
        NSTask *task = [[NSTask alloc] init];
        task.executableURL = [NSURL fileURLWithPath:[resources stringByAppendingPathComponent:@"runtime/node"]];
        NSString *script = [resources stringByAppendingPathComponent:@"app/bin/desktop.mjs"];
        task.arguments = loginHelper ? @[script, @"--no-browser"] : @[script];
        task.currentDirectoryURL = [NSURL fileURLWithPath:resources];
        task.standardOutput = log;
        task.standardError = log;
        int status = 1;
        if ([task launchAndReturnError:&error]) {
            [task waitUntilExit];
            status = task.terminationStatus;
        } else {
            [log writeData:[[error.localizedDescription stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding]];
        }
        [log closeFile];
        if (status != 0 && !loginHelper) {
            NSTask *showLog = [[NSTask alloc] init];
            showLog.executableURL = [NSURL fileURLWithPath:@"/usr/bin/open"];
            showLog.arguments = @[logPath];
            [showLog launchAndReturnError:nil];
        }
        return status;
    }
}
