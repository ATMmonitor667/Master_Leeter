# Author-owned reference; never execute candidate submissions here.
def merge_windows(windows):
    result = []
    for start, end in sorted((start, end) for start, end in windows if start < end):
        if result and start <= result[-1][1]:
            result[-1][1] = max(result[-1][1], end)
        else:
            result.append([start, end])
    return result

