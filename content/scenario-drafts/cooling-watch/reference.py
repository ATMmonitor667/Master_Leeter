# Author-owned reference; never execute candidate submissions here.
def cooling_wait(readings):
    answer = [0] * len(readings)
    pending = []
    for index, value in enumerate(readings):
        while pending and value < readings[pending[-1]]:
            previous = pending.pop()
            answer[previous] = index - previous
        pending.append(index)
    return answer

