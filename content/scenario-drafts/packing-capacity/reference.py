# Author-owned reference; never execute candidate submissions here.
def minimum_capacity(weights, days):
    if not weights:
        return 0
    low, high = max(weights), sum(weights)
    while low < high:
        middle = (low + high) // 2
        used, load = 1, 0
        for weight in weights:
            if load + weight > middle:
                used, load = used + 1, 0
            load += weight
        if used <= days:
            high = middle
        else:
            low = middle + 1
    return low

