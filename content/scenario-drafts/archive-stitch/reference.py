# Author-owned reference; never execute candidate submissions here.
def minimum_labels(message, labels):
    unique = set(labels)
    n = len(message)
    dp = [n + 1] * (n + 1)
    dp[0] = 0
    for index in range(n):
        if dp[index] == n + 1:
            continue
        for label in unique:
            if message.startswith(label, index):
                end = index + len(label)
                dp[end] = min(dp[end], dp[index] + 1)
    return -1 if dp[n] == n + 1 else dp[n]

